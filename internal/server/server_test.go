package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"openlist-clipboard/internal/storage"
)

type testGroup struct {
	id      string
	name    string
	keyHash string
	key     *ecdsa.PrivateKey
	jwk     publicJWK
}

func testServer() (http.Handler, *memoryStore) {
	store := newMemoryStore()
	handler := New(Config{MaxBlobBytes: 1024, CreatePassword: "create-secret"}, store)
	return handler, store
}

func TestCreateGroupIdempotentAndRejectDifferentKey(t *testing.T) {
	handler, _ := testServer()
	group := newTestGroup(t, 1)
	createGroup(t, handler, group, http.StatusCreated)
	createGroup(t, handler, group, http.StatusOK)

	other := newTestGroup(t, 2)
	other.id = group.id
	createGroup(t, handler, other, http.StatusConflict)
}

func TestCreatePasswordAndJoinKeyHash(t *testing.T) {
	handler, _ := testServer()
	group := newTestGroup(t, 1)

	reqBody, _ := json.Marshal(map[string]any{
		"groupId":        group.id,
		"name":           group.name,
		"keyHash":        group.keyHash,
		"publicKeyJwk":   group.jwk,
		"createPassword": "wrong",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/groups", bytes.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong create password status=%d body=%s", rec.Code, rec.Body.String())
	}

	createGroup(t, handler, group, http.StatusCreated)
	joinGroup(t, handler, group, group.keyHash, http.StatusOK)
	joinGroup(t, handler, group, strings.Repeat("A", 43), http.StatusUnauthorized)
}

func TestSignedIndexConflictAndGroupIsolation(t *testing.T) {
	handler, _ := testServer()
	groupA := newTestGroup(t, 1)
	groupB := newTestGroup(t, 2)
	createGroup(t, handler, groupA, http.StatusCreated)
	createGroup(t, handler, groupB, http.StatusCreated)

	first := putIndex(t, handler, groupA, "", []byte("first"), http.StatusOK)
	if first == "" {
		t.Fatal("missing first hash")
	}
	putIndex(t, handler, groupA, "", []byte("second"), http.StatusConflict)

	body := signedRequest(t, http.MethodGet, "/api/v1/groups/"+groupA.id+"/index", nil, groupB, "")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, body)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("cross-group status=%d body=%s", rec.Code, rec.Body.String())
	}

	getB := signedRequest(t, http.MethodGet, "/api/v1/groups/"+groupB.id+"/index", nil, groupB, "")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, getB)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"hash":""`) {
		t.Fatalf("group b index status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRejectUnsignedInvalidReplayAndOversize(t *testing.T) {
	handler, _ := testServer()
	group := newTestGroup(t, 1)
	createGroup(t, handler, group, http.StatusCreated)

	unsigned := httptest.NewRequest(http.MethodGet, "/api/v1/groups/"+group.id+"/index", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, unsigned)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unsigned status=%d body=%s", rec.Code, rec.Body.String())
	}

	req := signedRequest(t, http.MethodGet, "/api/v1/groups/"+group.id+"/index", nil, group, "replay-nonce-value")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("first nonce status=%d body=%s", rec.Code, rec.Body.String())
	}
	req = signedRequest(t, http.MethodGet, "/api/v1/groups/"+group.id+"/index", nil, group, "replay-nonce-value")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("replay status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = signedRequest(t, http.MethodPost, "/api/v1/groups/"+group.id+"/blobs", []byte(strings.Repeat("x", 1025)), group, "")
	req.Header.Set("Content-Type", "application/octet-stream")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestInvalidSignatureDoesNotConsumeNonce(t *testing.T) {
	handler, _ := testServer()
	group := newTestGroup(t, 1)
	createGroup(t, handler, group, http.StatusCreated)

	const nonce = "valid-after-invalid-signature"
	invalid := signedRequest(t, http.MethodGet, "/api/v1/groups/"+group.id+"/index", nil, group, nonce)
	invalid.Header.Set("X-Request-Signature", strings.Repeat("A", 86))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, invalid)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("invalid signature status=%d body=%s", rec.Code, rec.Body.String())
	}

	valid := signedRequest(t, http.MethodGet, "/api/v1/groups/"+group.id+"/index", nil, group, nonce)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, valid)
	if rec.Code != http.StatusOK {
		t.Fatalf("valid request status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestBlobRoundTrip(t *testing.T) {
	handler, _ := testServer()
	group := newTestGroup(t, 1)
	createGroup(t, handler, group, http.StatusCreated)

	req := signedRequest(t, http.MethodPost, "/api/v1/groups/"+group.id+"/blobs", []byte("ciphertext"), group, "")
	req.Header.Set("Content-Type", "application/octet-stream")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", rec.Code, rec.Body.String())
	}
	var created struct {
		ClipID string `json:"clipId"`
		Size   int    `json:"size"`
		Hash   string `json:"hash"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if !clipIDPattern.MatchString(created.ClipID) {
		t.Fatalf("invalid clip id: %s", created.ClipID)
	}
	if created.Size != len("ciphertext") || created.Hash != hash([]byte("ciphertext")) {
		t.Fatalf("blob metadata size=%d hash=%s", created.Size, created.Hash)
	}

	get := signedRequest(t, http.MethodGet, "/api/v1/groups/"+group.id+"/blobs/"+created.ClipID, nil, group, "")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, get)
	if rec.Code != http.StatusOK || rec.Body.String() != "ciphertext" {
		t.Fatalf("download status=%d body=%q", rec.Code, rec.Body.String())
	}
}

func TestClientIPTrustProxyHeaders(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.5:12345"
	req.Header.Set("X-Forwarded-For", "203.0.113.10, 10.0.0.5")

	if got := clientIP(req, false); got != "10.0.0.5" {
		t.Fatalf("clientIP without trust=%s", got)
	}
	if got := clientIP(req, true); got != "203.0.113.10" {
		t.Fatalf("clientIP with trust=%s", got)
	}
}

func TestStaticServesServiceWorkerFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/index.html", []byte("index"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir+"/sw.js", []byte("worker"), 0644); err != nil {
		t.Fatal(err)
	}
	handler := New(Config{MaxBlobBytes: 1024, StaticDir: dir}, newMemoryStore())

	req := httptest.NewRequest(http.MethodGet, "/sw.js", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "worker" {
		t.Fatalf("sw.js status=%d body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("sw.js Cache-Control=%q", got)
	}
}

func TestSecurityAndCacheHeaders(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(dir+"/assets", 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir+"/index.html", []byte("index"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir+"/assets/app.js", []byte("app"), 0644); err != nil {
		t.Fatal(err)
	}
	handler := New(Config{MaxBlobBytes: 1024, StaticDir: dir}, newMemoryStore())

	asset := httptest.NewRecorder()
	handler.ServeHTTP(asset, httptest.NewRequest(http.MethodGet, "/assets/app.js", nil))
	if got := asset.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("asset Cache-Control=%q", got)
	}
	if got := asset.Header().Get("Cross-Origin-Opener-Policy"); got != "same-origin" {
		t.Fatalf("COOP=%q", got)
	}
	if got := asset.Header().Get("Content-Security-Policy"); !strings.Contains(got, "form-action 'self'") || strings.Contains(got, "unsafe-inline") {
		t.Fatalf("CSP=%q", got)
	}

	api := httptest.NewRecorder()
	handler.ServeHTTP(api, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if got := api.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("API Cache-Control=%q", got)
	}
}

func TestIndexEventsBroadcastGroupScoped(t *testing.T) {
	handler, _ := testServer()
	groupA := newTestGroup(t, 1)
	groupB := newTestGroup(t, 2)
	createGroup(t, handler, groupA, http.StatusCreated)
	createGroup(t, handler, groupB, http.StatusCreated)
	server := httptest.NewServer(handler)
	defer server.Close()

	pathA := "/api/v1/groups/" + groupA.id + "/events"
	req, err := http.NewRequest(http.MethodGet, server.URL+pathA, nil)
	if err != nil {
		t.Fatal(err)
	}
	signExistingRequest(t, req, nil, groupA, "")
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("events status=%d", resp.StatusCode)
	}

	reader := bufio.NewReader(resp.Body)
	initial := readSSEData(t, reader)
	if !strings.Contains(initial, `"hash":""`) {
		t.Fatalf("initial event=%s", initial)
	}

	putIndex(t, handler, groupB, "", []byte("group-b"), http.StatusOK)
	nextHash := putIndex(t, handler, groupA, "", []byte("group-a"), http.StatusOK)
	update := readSSEData(t, reader)
	if !strings.Contains(update, nextHash) {
		t.Fatalf("update event=%s want hash=%s", update, nextHash)
	}
}

func TestRuntimeConfigReportsPushAndChunkSettings(t *testing.T) {
	store := newMemoryStore()
	handler := New(Config{
		MaxBlobBytes:    1024,
		CreatePassword:  "create-secret",
		VAPIDPublicKey:  "public-key",
		VAPIDPrivateKey: "private-key",
		VAPIDSubject:    "mailto:test@example.com",
		PushSender:      &recordingPushSender{},
	}, store)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/runtime-config", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("runtime config status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"webPushEnabled":true`) || !strings.Contains(rec.Body.String(), `"chunkPlainBytes":960`) || !strings.Contains(rec.Body.String(), `"maxBlobBytes":1024`) {
		t.Fatalf("runtime config body=%s", rec.Body.String())
	}
}

func TestPushSubscriptionCRUD(t *testing.T) {
	store := newMemoryStore()
	handler := New(Config{
		MaxBlobBytes:    1024,
		CreatePassword:  "create-secret",
		VAPIDPublicKey:  "public-key",
		VAPIDPrivateKey: "private-key",
		VAPIDSubject:    "mailto:test@example.com",
		PushSender:      &recordingPushSender{},
	}, store)
	group := newTestGroup(t, 1)
	createGroup(t, handler, group, http.StatusCreated)

	body, _ := json.Marshal(map[string]any{
		"clientId": "client-a",
		"endpoint": "https://push.example/sub-a",
		"keys": map[string]string{
			"p256dh": "p256dh-key",
			"auth":   "auth-key",
		},
	})
	req := signedRequest(t, http.MethodPost, "/api/v1/groups/"+group.id+"/push-subscriptions", body, group, "")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("subscribe status=%d body=%s", rec.Code, rec.Body.String())
	}
	subscriptions, err := store.ReadPushSubscriptions(context.Background(), group.id)
	if err != nil {
		t.Fatal(err)
	}
	if len(subscriptions) != 1 || subscriptions[0].ClientID != "client-a" {
		t.Fatalf("subscriptions=%+v", subscriptions)
	}

	body, _ = json.Marshal(map[string]string{
		"clientId": "client-a",
		"endpoint": "https://push.example/sub-a",
	})
	req = signedRequest(t, http.MethodDelete, "/api/v1/groups/"+group.id+"/push-subscriptions", body, group, "")
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("unsubscribe status=%d body=%s", rec.Code, rec.Body.String())
	}
	subscriptions, err = store.ReadPushSubscriptions(context.Background(), group.id)
	if err != nil {
		t.Fatal(err)
	}
	if len(subscriptions) != 0 {
		t.Fatalf("subscriptions after delete=%+v", subscriptions)
	}
}

func TestSendPushNotificationsSkipsSourceClientAndRemovesExpired(t *testing.T) {
	store := newMemoryStore()
	group := newTestGroup(t, 1)
	if err := store.WritePushSubscriptions(context.Background(), group.id, []storage.PushSubscription{
		{ClientID: "source", Endpoint: "https://push.example/source", P256DH: "key", Auth: "auth"},
		{ClientID: "other", Endpoint: "https://push.example/other", P256DH: "key", Auth: "auth"},
		{ClientID: "expired", Endpoint: "https://push.example/expired", P256DH: "key", Auth: "auth"},
	}); err != nil {
		t.Fatal(err)
	}
	sender := &recordingPushSender{removeEndpoint: "https://push.example/expired"}
	api := &API{store: store, push: sender}

	if err := api.sendPushNotifications(context.Background(), group.id, "source", "hash"); err != nil {
		t.Fatal(err)
	}
	if len(sender.sent) != 2 {
		t.Fatalf("sent=%+v", sender.sent)
	}
	for _, subscription := range sender.sent {
		if subscription.ClientID == "source" {
			t.Fatalf("source client was notified: %+v", sender.sent)
		}
	}
	subscriptions, err := store.ReadPushSubscriptions(context.Background(), group.id)
	if err != nil {
		t.Fatal(err)
	}
	for _, subscription := range subscriptions {
		if subscription.ClientID == "expired" {
			t.Fatalf("expired subscription was retained: %+v", subscriptions)
		}
	}
}

type recordingPushSender struct {
	removeEndpoint string
	sent           []storage.PushSubscription
}

func (s *recordingPushSender) Send(_ context.Context, subscription storage.PushSubscription, _ []byte) (bool, error) {
	s.sent = append(s.sent, subscription)
	return subscription.Endpoint == s.removeEndpoint, nil
}

func newTestGroup(t *testing.T, seed byte) testGroup {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	groupIDRaw := bytes.Repeat([]byte{seed}, 32)
	return testGroup{
		id:      base64.RawURLEncoding.EncodeToString(groupIDRaw),
		name:    fmt.Sprintf("Clipboard %d", seed),
		keyHash: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{seed + 10}, 32)),
		key:     key,
		jwk: publicJWK{
			Kty: "EC",
			Crv: "P-256",
			X:   base64.RawURLEncoding.EncodeToString(pad32(key.X.Bytes())),
			Y:   base64.RawURLEncoding.EncodeToString(pad32(key.Y.Bytes())),
		},
	}
}

func createGroup(t *testing.T, handler http.Handler, group testGroup, wantStatus int) {
	t.Helper()
	reqBody, _ := json.Marshal(map[string]any{
		"groupId":        group.id,
		"name":           group.name,
		"keyHash":        group.keyHash,
		"publicKeyJwk":   group.jwk,
		"createPassword": "create-secret",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/groups", bytes.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != wantStatus {
		t.Fatalf("create group status=%d want=%d body=%s", rec.Code, wantStatus, rec.Body.String())
	}
}

func joinGroup(t *testing.T, handler http.Handler, group testGroup, keyHash string, wantStatus int) {
	t.Helper()
	reqBody, _ := json.Marshal(map[string]any{
		"keyHash":      keyHash,
		"publicKeyJwk": group.jwk,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/groups/"+group.id+"/join", bytes.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != wantStatus {
		t.Fatalf("join group status=%d want=%d body=%s", rec.Code, wantStatus, rec.Body.String())
	}
	if wantStatus == http.StatusOK && !strings.Contains(rec.Body.String(), group.name) {
		t.Fatalf("join response missing name: %s", rec.Body.String())
	}
}

func putIndex(t *testing.T, handler http.Handler, group testGroup, baseHash string, raw []byte, wantStatus int) string {
	t.Helper()
	reqBody, _ := json.Marshal(map[string]string{
		"baseHash": baseHash,
		"blob":     base64.StdEncoding.EncodeToString(raw),
	})
	req := signedRequest(t, http.MethodPut, "/api/v1/groups/"+group.id+"/index", reqBody, group, "")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != wantStatus {
		t.Fatalf("put index status=%d want=%d body=%s", rec.Code, wantStatus, rec.Body.String())
	}
	var resp struct {
		Hash string `json:"hash"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	return resp.Hash
}

func signedRequest(t *testing.T, method string, path string, body []byte, group testGroup, nonce string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	signExistingRequest(t, req, body, group, nonce)
	return req
}

func signExistingRequest(t *testing.T, req *http.Request, body []byte, group testGroup, nonce string) {
	t.Helper()
	if nonce == "" {
		raw := make([]byte, 18)
		if _, err := rand.Read(raw); err != nil {
			t.Fatal(err)
		}
		nonce = "nonce-" + base64.RawURLEncoding.EncodeToString(raw)
	}
	timestamp := fmtTimestamp(time.Now())
	bodyHash := sha256.Sum256(body)
	canonical := strings.Join([]string{
		req.Method,
		req.URL.EscapedPath(),
		req.URL.RawQuery,
		hex.EncodeToString(bodyHash[:]),
		timestamp,
		nonce,
	}, "\n")
	digest := sha256.Sum256([]byte(canonical))
	r, s, err := ecdsa.Sign(rand.Reader, group.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Group-ID", group.id)
	req.Header.Set("X-Request-Timestamp", timestamp)
	req.Header.Set("X-Request-Nonce", nonce)
	req.Header.Set("X-Request-Signature", base64.RawURLEncoding.EncodeToString(append(pad32(r.Bytes()), pad32(s.Bytes())...)))
}

func readSSEData(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	type result struct {
		data string
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				ch <- result{err: err}
				return
			}
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "data:") {
				ch <- result{data: strings.TrimSpace(strings.TrimPrefix(line, "data:"))}
				return
			}
		}
	}()

	select {
	case got := <-ch:
		if got.err != nil {
			t.Fatal(got.err)
		}
		return got.data
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for sse data")
		return ""
	}
}

func pad32(raw []byte) []byte {
	out := make([]byte, 32)
	copy(out[32-len(raw):], raw)
	return out
}

func fmtTimestamp(now time.Time) string {
	return fmt.Sprintf("%d", now.UnixMilli())
}
