package server

import (
	"bufio"
	"bytes"
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
	"strings"
	"testing"
	"time"
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
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if !clipIDPattern.MatchString(created.ClipID) {
		t.Fatalf("invalid clip id: %s", created.ClipID)
	}

	get := signedRequest(t, http.MethodGet, "/api/v1/groups/"+group.id+"/blobs/"+created.ClipID, nil, group, "")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, get)
	if rec.Code != http.StatusOK || rec.Body.String() != "ciphertext" {
		t.Fatalf("download status=%d body=%q", rec.Code, rec.Body.String())
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
