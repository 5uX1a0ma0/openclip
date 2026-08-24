package server

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"openlist-clipboard/internal/storage"
)

var (
	clipIDPattern  = regexp.MustCompile(`^[0-9]{6}-[A-Za-z0-9_-]{22}$`)
	groupIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	keyHashPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	noncePattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
)

type Config struct {
	AllowedOrigin     string
	CreatePassword    string
	MaxBlobBytes      int64
	TrustProxyHeaders bool
	StaticDir         string
	VAPIDPublicKey    string
	VAPIDPrivateKey   string
	VAPIDSubject      string
	PushSender        PushSender
}

type API struct {
	cfg        Config
	store      storage.Store
	limiter    *RateLimiter
	events     *IndexEventHub
	nonces     *NonceStore
	push       PushSender
	indexLocks [32]sync.Mutex
}

type signedBody struct {
	size    int64
	hashHex string
	reader  io.ReadSeeker
	cleanup func()
}

type signedBodyKey struct{}

func New(cfg Config, store storage.Store) http.Handler {
	if cfg.MaxBlobBytes <= 0 {
		cfg.MaxBlobBytes = 50 * 1024 * 1024
	}
	if cfg.StaticDir == "" {
		cfg.StaticDir = "frontend/dist"
	}
	api := &API{
		cfg:     cfg,
		store:   store,
		limiter: NewRateLimiter(120, time.Minute),
		events:  NewIndexEventHub(),
		nonces:  NewNonceStore(5 * time.Minute),
	}
	api.push = cfg.PushSender
	if api.push == nil && cfg.VAPIDPublicKey != "" && cfg.VAPIDPrivateKey != "" && cfg.VAPIDSubject != "" {
		api.push = NewWebPushSender(cfg.VAPIDPublicKey, cfg.VAPIDPrivateKey, cfg.VAPIDSubject)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", api.health)
	mux.HandleFunc("GET /api/v1/runtime-config", api.runtimeConfig)
	mux.HandleFunc("POST /api/v1/groups", api.createGroup)
	mux.HandleFunc("POST /api/v1/groups/{groupID}/join", api.joinGroup)
	mux.HandleFunc("GET /api/v1/groups/{groupID}/index", api.withGroupAuth(api.getIndex))
	mux.HandleFunc("PUT /api/v1/groups/{groupID}/index", api.withGroupAuth(api.putIndex))
	mux.HandleFunc("GET /api/v1/groups/{groupID}/events", api.withGroupAuth(api.indexEvents))
	mux.HandleFunc("POST /api/v1/groups/{groupID}/push-subscriptions", api.withGroupAuth(api.postPushSubscription))
	mux.HandleFunc("DELETE /api/v1/groups/{groupID}/push-subscriptions", api.withGroupAuth(api.deletePushSubscription))
	mux.HandleFunc("POST /api/v1/groups/{groupID}/blobs", api.withGroupAuth(api.postBlob))
	mux.HandleFunc("GET /api/v1/groups/{groupID}/blobs/{clipID}", api.withGroupAuth(api.getBlob))
	mux.HandleFunc("DELETE /api/v1/groups/{groupID}/blobs/{clipID}", api.withGroupAuth(api.deleteBlob))
	mux.HandleFunc("/", api.static)

	return api.securityHeaders(api.cors(api.rateLimit(mux)))
}

func (a *API) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) runtimeConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"chunkPlainBytes": a.chunkPlainBytes(),
		"maxBlobBytes":     a.cfg.MaxBlobBytes,
		"webPushEnabled":  a.push != nil && a.cfg.VAPIDPublicKey != "",
		"vapidPublicKey":  a.cfg.VAPIDPublicKey,
	})
}

func (a *API) chunkPlainBytes() int64 {
	const envelopeOverhead = 64
	if a.cfg.MaxBlobBytes <= envelopeOverhead {
		return 1
	}
	if a.cfg.MaxBlobBytes-envelopeOverhead < defaultChunkPlainBytes {
		return a.cfg.MaxBlobBytes - envelopeOverhead
	}
	return defaultChunkPlainBytes
}

func (a *API) createGroup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		GroupID        string          `json:"groupId"`
		Name           string          `json:"name"`
		KeyHash        string          `json:"keyHash"`
		PublicKeyJWK   json.RawMessage `json:"publicKeyJwk"`
		CreatePassword string          `json:"createPassword"`
	}
	if err := decodeJSON(r, &req, 16*1024); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if !a.createPasswordAllowed(req.CreatePassword) {
		writeError(w, http.StatusUnauthorized, "create password failed")
		return
	}
	if !groupIDPattern.MatchString(req.GroupID) {
		writeError(w, http.StatusBadRequest, "invalid group id")
		return
	}
	if !keyHashPattern.MatchString(req.KeyHash) {
		writeError(w, http.StatusBadRequest, "invalid key hash")
		return
	}
	name := cleanGroupName(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "clipboard name is required")
		return
	}
	publicKeyJWK, _, err := normalizePublicKeyJWK(req.PublicKeyJWK)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid public key")
		return
	}

	existing, err := a.store.ReadGroup(r.Context(), req.GroupID)
	if err == nil {
		if !bytes.Equal(existing.PublicKeyJWK, publicKeyJWK) || existing.KeyHash != req.KeyHash {
			writeError(w, http.StatusConflict, "group already exists with a different key")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "groupId": req.GroupID, "name": existing.Name})
		return
	}
	if !errors.Is(err, storage.ErrNotFound) {
		writeError(w, http.StatusBadGateway, "openlist read failed")
		return
	}

	now := time.Now().UnixMilli()
	group := storage.Group{
		Version:      1,
		GroupID:      req.GroupID,
		Name:         name,
		KeyHash:      req.KeyHash,
		PublicKeyJWK: publicKeyJWK,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := a.store.WriteGroup(r.Context(), group); err != nil {
		writeError(w, http.StatusBadGateway, "openlist write failed")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "groupId": req.GroupID, "name": name})
}

func (a *API) joinGroup(w http.ResponseWriter, r *http.Request) {
	groupID := r.PathValue("groupID")
	if !groupIDPattern.MatchString(groupID) {
		writeError(w, http.StatusBadRequest, "invalid group id")
		return
	}
	var req struct {
		KeyHash      string          `json:"keyHash"`
		PublicKeyJWK json.RawMessage `json:"publicKeyJwk"`
	}
	if err := decodeJSON(r, &req, 1024); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if !keyHashPattern.MatchString(req.KeyHash) {
		writeError(w, http.StatusBadRequest, "invalid key hash")
		return
	}
	publicKeyJWK, _, err := normalizePublicKeyJWK(req.PublicKeyJWK)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid public key")
		return
	}
	group, err := a.store.ReadGroup(r.Context(), groupID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "clipboard not found")
			return
		}
		writeError(w, http.StatusBadGateway, "openlist read failed")
		return
	}
	if group.KeyHash == "" || subtle.ConstantTimeCompare([]byte(group.KeyHash), []byte(req.KeyHash)) != 1 {
		writeError(w, http.StatusUnauthorized, "clipboard key failed")
		return
	}
	if !bytes.Equal(group.PublicKeyJWK, publicKeyJWK) {
		writeError(w, http.StatusUnauthorized, "clipboard key failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"groupId": group.GroupID,
		"name":    group.Name,
	})
}

func (a *API) getIndex(w http.ResponseWriter, r *http.Request, groupID string) {
	data, err := a.store.ReadIndex(r.Context(), groupID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeJSON(w, http.StatusOK, map[string]string{"hash": "", "blob": ""})
			return
		}
		writeError(w, http.StatusBadGateway, "openlist read failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"hash": hash(data),
		"blob": base64.StdEncoding.EncodeToString(data),
	})
}

func (a *API) putIndex(w http.ResponseWriter, r *http.Request, groupID string) {
	var req struct {
		BaseHash string `json:"baseHash"`
		Blob     string `json:"blob"`
		ClientID string `json:"clientId"`
	}
	if err := decodeJSON(r, &req, a.cfg.MaxBlobBytes+4096); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	data, err := base64.StdEncoding.DecodeString(req.Blob)
	if err != nil || len(data) == 0 {
		writeError(w, http.StatusBadRequest, "invalid encrypted index")
		return
	}
	if int64(len(data)) > a.cfg.MaxBlobBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "index too large")
		return
	}

	lock := a.indexLock(groupID)
	lock.Lock()
	defer lock.Unlock()

	current, err := a.store.ReadIndex(r.Context(), groupID)
	currentHash := ""
	if err == nil {
		currentHash = hash(current)
	} else if !errors.Is(err, storage.ErrNotFound) {
		writeError(w, http.StatusBadGateway, "openlist read failed")
		return
	}
	if currentHash != req.BaseHash {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "index conflict", "hash": currentHash})
		return
	}
	if err := a.store.WriteIndex(r.Context(), groupID, data); err != nil {
		writeError(w, http.StatusBadGateway, "openlist write failed")
		return
	}
	nextHash := hash(data)
	a.events.Broadcast(groupID, nextHash)
	a.notifyPushSubscribers(groupID, req.ClientID, nextHash)
	writeJSON(w, http.StatusOK, map[string]string{"hash": nextHash})
}

func (a *API) indexEvents(w http.ResponseWriter, r *http.Request, groupID string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unavailable")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch, unsubscribe := a.events.Subscribe(groupID)
	defer unsubscribe()

	currentHash := ""
	if data, err := a.store.ReadIndex(r.Context(), groupID); err == nil {
		currentHash = hash(data)
	} else if err != nil && !errors.Is(err, storage.ErrNotFound) {
		writeSSE(w, "error", map[string]string{"error": "openlist read failed"})
		flusher.Flush()
		return
	}

	writeSSE(w, "index", map[string]string{"hash": currentHash})
	flusher.Flush()

	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case nextHash := <-ch:
			writeSSE(w, "index", map[string]string{"hash": nextHash})
			flusher.Flush()
		case <-heartbeat.C:
			_, _ = io.WriteString(w, ": keepalive\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (a *API) postBlob(w http.ResponseWriter, r *http.Request, groupID string) {
	if r.ContentLength < 0 {
		writeError(w, http.StatusLengthRequired, "content length required")
		return
	}
	if r.ContentLength == 0 {
		writeError(w, http.StatusBadRequest, "empty blob")
		return
	}
	if r.ContentLength > a.cfg.MaxBlobBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "blob too large")
		return
	}

	clipID, err := newClipID(time.Now())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "id generation failed")
		return
	}

	body := signedRequestBody(r)
	if body == nil {
		writeError(w, http.StatusBadRequest, "missing signed body")
		return
	}
	if body.size != r.ContentLength {
		writeError(w, http.StatusBadRequest, "short upload")
		return
	}
	if _, err := body.reader.Seek(0, io.SeekStart); err != nil {
		writeError(w, http.StatusInternalServerError, "upload rewind failed")
		return
	}
	if err := a.store.WriteBlob(r.Context(), groupID, clipID, body.reader, body.size); err != nil {
		writeError(w, http.StatusBadGateway, "openlist write failed")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"clipId": clipID,
		"size":   body.size,
		"hash":   body.hashHex,
	})
}

func (a *API) getBlob(w http.ResponseWriter, r *http.Request, groupID string) {
	clipID := r.PathValue("clipID")
	if !clipIDPattern.MatchString(clipID) {
		writeError(w, http.StatusBadRequest, "invalid clip id")
		return
	}
	body, size, err := a.store.ReadBlob(r.Context(), groupID, clipID)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeError(w, http.StatusBadGateway, "openlist read failed")
		return
	}
	defer body.Close()
	if size > a.cfg.MaxBlobBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "blob too large")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.bin"`, clipID))
	if size >= 0 {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", size))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, body)
}

func (a *API) deleteBlob(w http.ResponseWriter, r *http.Request, groupID string) {
	clipID := r.PathValue("clipID")
	if !clipIDPattern.MatchString(clipID) {
		writeError(w, http.StatusBadRequest, "invalid clip id")
		return
	}
	if err := a.store.DeleteBlob(r.Context(), groupID, clipID); err != nil && !errors.Is(err, storage.ErrNotFound) {
		writeError(w, http.StatusBadGateway, "openlist delete failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) withGroupAuth(next func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		groupID := r.PathValue("groupID")
		if !groupIDPattern.MatchString(groupID) {
			writeError(w, http.StatusBadRequest, "invalid group id")
			return
		}
		if headerGroupID := r.Header.Get("X-Group-ID"); headerGroupID != "" && headerGroupID != groupID {
			writeError(w, http.StatusUnauthorized, "group mismatch")
			return
		}

		body, err := readSignedBody(w, r, a.cfg.MaxBlobBytes+4096)
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "request too large")
			return
		}
		defer body.cleanup()
		if _, err := body.reader.Seek(0, io.SeekStart); err != nil {
			writeError(w, http.StatusInternalServerError, "request rewind failed")
			return
		}
		r.Body = io.NopCloser(body.reader)
		r = r.WithContext(contextWithSignedBody(r.Context(), body))

		group, err := a.store.ReadGroup(r.Context(), groupID)
		if err != nil {
			if errors.Is(err, storage.ErrNotFound) {
				writeError(w, http.StatusNotFound, "group not found")
				return
			}
			writeError(w, http.StatusBadGateway, "openlist read failed")
			return
		}
		_, publicKey, err := normalizePublicKeyJWK(group.PublicKeyJWK)
		if err != nil {
			writeError(w, http.StatusBadGateway, "stored public key is invalid")
			return
		}
		if !a.verifyRequest(r, body.hashHex, groupID, publicKey) {
			writeError(w, http.StatusUnauthorized, "signature failed")
			return
		}

		next(w, r, groupID)
	}
}

func (a *API) verifyRequest(r *http.Request, bodyHashHex string, groupID string, publicKey *ecdsa.PublicKey) bool {
	timestamp := r.Header.Get("X-Request-Timestamp")
	nonce := r.Header.Get("X-Request-Nonce")
	signature := r.Header.Get("X-Request-Signature")
	if timestamp == "" || nonce == "" || signature == "" || !noncePattern.MatchString(nonce) {
		return false
	}
	parsedTimestamp, err := parseTimestampMillis(timestamp)
	if err != nil || !timestampAllowed(parsedTimestamp, time.Now()) {
		return false
	}
	canonical := strings.Join([]string{
		r.Method,
		r.URL.EscapedPath(),
		r.URL.RawQuery,
		bodyHashHex,
		timestamp,
		nonce,
	}, "\n")
	sig, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(sig) != 64 {
		return false
	}
	digest := sha256.Sum256([]byte(canonical))
	rValue := new(big.Int).SetBytes(sig[:32])
	sValue := new(big.Int).SetBytes(sig[32:])
	return ecdsa.Verify(publicKey, digest[:], rValue, sValue) && a.nonces.Allow(groupID, nonce, time.Now())
}

func (a *API) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
		if r.TLS != nil {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func (a *API) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.cfg.AllowedOrigin != "" && r.Header.Get("Origin") == a.cfg.AllowedOrigin {
			w.Header().Set("Access-Control-Allow-Origin", a.cfg.AllowedOrigin)
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Group-ID, X-Request-Timestamp, X-Request-Nonce, X-Request-Signature")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *API) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := clientIP(r, a.cfg.TrustProxyHeaders)
		if !a.limiter.Allow(key) {
			writeError(w, http.StatusTooManyRequests, "too many requests")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *API) static(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	indexPath := filepath.Join(a.cfg.StaticDir, "index.html")
	if _, err := os.Stat(indexPath); err != nil {
		writeError(w, http.StatusNotFound, "frontend is not built")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		http.StripPrefix("/assets", http.FileServer(http.Dir(filepath.Join(a.cfg.StaticDir, "assets")))).ServeHTTP(w, r)
		return
	}
	rel := strings.TrimPrefix(filepath.Clean("/"+strings.TrimPrefix(r.URL.Path, "/")), "/")
	if rel != "." && rel != "" {
		staticPath := filepath.Join(a.cfg.StaticDir, rel)
		if info, err := os.Stat(staticPath); err == nil && !info.IsDir() {
			if rel == "sw.js" || rel == "manifest.webmanifest" {
				w.Header().Set("Cache-Control", "no-cache")
			}
			http.ServeFile(w, r, staticPath)
			return
		}
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, indexPath)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeSSE(w io.Writer, event string, value any) {
	payload, err := json.Marshal(value)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, payload)
}

func decodeJSON(r *http.Request, out any, limit int64) error {
	if limit <= 0 {
		limit = 1 << 20
	}
	reader := io.LimitReader(r.Body, limit)
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	return decoder.Decode(out)
}

func readSignedBody(w http.ResponseWriter, r *http.Request, limit int64) (*signedBody, error) {
	if r.Body == nil {
		return newMemorySignedBody(nil), nil
	}
	body := http.MaxBytesReader(w, r.Body, limit)
	defer body.Close()
	if r.ContentLength >= 0 && r.ContentLength <= 1<<20 {
		raw, err := io.ReadAll(body)
		if err != nil {
			return nil, err
		}
		return newMemorySignedBody(raw), nil
	}

	tmp, err := os.CreateTemp("", "openlist-clipboard-*")
	if err != nil {
		return nil, err
	}
	cleanup := func() {
		name := tmp.Name()
		_ = tmp.Close()
		_ = os.Remove(name)
	}
	hasher := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, hasher), body)
	if err != nil {
		cleanup()
		return nil, err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		cleanup()
		return nil, err
	}
	return &signedBody{
		size:    n,
		hashHex: hex.EncodeToString(hasher.Sum(nil)),
		reader:  tmp,
		cleanup: cleanup,
	}, nil
}

func newMemorySignedBody(raw []byte) *signedBody {
	sum := sha256.Sum256(raw)
	return &signedBody{
		size:    int64(len(raw)),
		hashHex: hex.EncodeToString(sum[:]),
		reader:  bytes.NewReader(raw),
		cleanup: func() {},
	}
}

func contextWithSignedBody(ctx context.Context, body *signedBody) context.Context {
	return context.WithValue(ctx, signedBodyKey{}, body)
}

func signedRequestBody(r *http.Request) *signedBody {
	body, _ := r.Context().Value(signedBodyKey{}).(*signedBody)
	return body
}

func clientIP(r *http.Request, trustProxyHeaders bool) string {
	host := hostOnly(r.RemoteAddr)
	if trustProxyHeaders {
		forwarded := r.Header.Get("X-Forwarded-For")
		if forwarded != "" {
			host = hostOnly(strings.TrimSpace(strings.Split(forwarded, ",")[0]))
		}
	}
	if host == "" {
		return "unknown"
	}
	return host
}

func hostOnly(value string) string {
	host, _, err := net.SplitHostPort(value)
	if err == nil {
		return host
	}
	return strings.Trim(value, "[]")
}

func hash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (a *API) indexLock(groupID string) *sync.Mutex {
	sum := sha256.Sum256([]byte(groupID))
	return &a.indexLocks[int(sum[0])%len(a.indexLocks)]
}

func (a *API) createPasswordAllowed(password string) bool {
	if a.cfg.CreatePassword == "" {
		return true
	}
	return subtle.ConstantTimeCompare([]byte(password), []byte(a.cfg.CreatePassword)) == 1
}

func cleanGroupName(name string) string {
	name = strings.TrimSpace(name)
	name = strings.Join(strings.Fields(name), " ")
	if len([]rune(name)) > 80 {
		return string([]rune(name)[:80])
	}
	return name
}

func randomToken(bytesLen int) (string, error) {
	raw := make([]byte, bytesLen)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func newClipID(now time.Time) (string, error) {
	token, err := randomToken(16)
	if err != nil {
		return "", err
	}
	return now.UTC().Format("200601") + "-" + token, nil
}

type publicJWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

func normalizePublicKeyJWK(raw []byte) ([]byte, *ecdsa.PublicKey, error) {
	var key publicJWK
	if err := json.Unmarshal(raw, &key); err != nil {
		return nil, nil, err
	}
	if key.Kty != "EC" || key.Crv != "P-256" || key.X == "" || key.Y == "" {
		return nil, nil, errors.New("unsupported key")
	}
	xBytes, err := base64.RawURLEncoding.DecodeString(key.X)
	if err != nil {
		return nil, nil, err
	}
	yBytes, err := base64.RawURLEncoding.DecodeString(key.Y)
	if err != nil {
		return nil, nil, err
	}
	if len(xBytes) != 32 || len(yBytes) != 32 {
		return nil, nil, errors.New("invalid coordinate size")
	}
	x := new(big.Int).SetBytes(xBytes)
	y := new(big.Int).SetBytes(yBytes)
	curve := elliptic.P256()
	if !curve.IsOnCurve(x, y) {
		return nil, nil, errors.New("point is not on curve")
	}
	normalized, err := json.Marshal(publicJWK{Kty: "EC", Crv: "P-256", X: key.X, Y: key.Y})
	if err != nil {
		return nil, nil, err
	}
	return normalized, &ecdsa.PublicKey{Curve: curve, X: x, Y: y}, nil
}

func parseTimestampMillis(value string) (int64, error) {
	var parsed int64
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return 0, errors.New("invalid timestamp")
		}
		parsed = parsed*10 + int64(ch-'0')
	}
	return parsed, nil
}

func timestampAllowed(timestamp int64, now time.Time) bool {
	delta := now.UnixMilli() - timestamp
	if delta < 0 {
		delta = -delta
	}
	return delta <= int64((5 * time.Minute).Milliseconds())
}

type IndexEventHub struct {
	mu      sync.Mutex
	clients map[string]map[chan string]struct{}
}

func NewIndexEventHub() *IndexEventHub {
	return &IndexEventHub{clients: make(map[string]map[chan string]struct{})}
}

func (h *IndexEventHub) Subscribe(groupID string) (<-chan string, func()) {
	ch := make(chan string, 1)
	h.mu.Lock()
	if h.clients[groupID] == nil {
		h.clients[groupID] = make(map[chan string]struct{})
	}
	h.clients[groupID][ch] = struct{}{}
	h.mu.Unlock()

	return ch, func() {
		h.mu.Lock()
		delete(h.clients[groupID], ch)
		if len(h.clients[groupID]) == 0 {
			delete(h.clients, groupID)
		}
		close(ch)
		h.mu.Unlock()
	}
}

func (h *IndexEventHub) Broadcast(groupID string, hash string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients[groupID] {
		select {
		case ch <- hash:
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- hash:
			default:
			}
		}
	}
}

type NonceStore struct {
	mu   sync.Mutex
	ttl  time.Duration
	seen map[string]map[string]time.Time
}

func NewNonceStore(ttl time.Duration) *NonceStore {
	return &NonceStore{ttl: ttl, seen: make(map[string]map[string]time.Time)}
}

func (s *NonceStore) Allow(groupID string, nonce string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	group := s.seen[groupID]
	if group == nil {
		group = make(map[string]time.Time)
		s.seen[groupID] = group
	}
	for existing, expires := range group {
		if now.After(expires) {
			delete(group, existing)
		}
	}
	if _, ok := group[nonce]; ok {
		return false
	}
	group[nonce] = now.Add(s.ttl)
	return true
}
