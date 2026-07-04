package openlist

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"openlist-clipboard/internal/storage"
)

var clipIDPattern = regexp.MustCompile(`^[0-9]{6}-[A-Za-z0-9_-]{22}$`)
var groupIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

type Config struct {
	BaseURL  string
	Username string
	Password string
	OTPCode  string
	Root     string
	ClientID string
	Timeout  time.Duration
	MaxBytes int64
}

type Client struct {
	cfg        Config
	httpClient *http.Client
	mu         sync.Mutex
	token      string
	tokenUntil time.Time
}

func NewClient(cfg Config) *Client {
	if cfg.Timeout == 0 {
		cfg.Timeout = 30 * time.Second
	}
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = 50 * 1024 * 1024
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	cfg.Root = cleanRoot(cfg.Root)
	return &Client{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: cfg.Timeout,
		},
	}
}

func (c *Client) Ensure(ctx context.Context) error {
	dirs := []string{
		c.cfg.Root,
		joinPath(c.cfg.Root, "v1"),
		joinPath(c.cfg.Root, "v1", "groups"),
	}
	for _, dir := range dirs {
		if err := c.mkdir(ctx, dir); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) ReadGroup(ctx context.Context, groupID string) (storage.Group, error) {
	groupPath, err := c.groupMetadataPath(groupID)
	if err != nil {
		return storage.Group{}, err
	}
	raw, err := c.readFile(ctx, groupPath, 1<<20)
	if err != nil {
		return storage.Group{}, err
	}
	var group storage.Group
	if err := json.Unmarshal(raw, &group); err != nil {
		return storage.Group{}, err
	}
	return group, nil
}

func (c *Client) WriteGroup(ctx context.Context, group storage.Group) error {
	groupPath, err := c.groupMetadataPath(group.GroupID)
	if err != nil {
		return err
	}
	if err := c.mkdir(ctx, path.Dir(groupPath)); err != nil {
		return err
	}
	if err := c.mkdir(ctx, joinPath(path.Dir(groupPath), "blobs")); err != nil {
		return err
	}
	raw, err := json.Marshal(group)
	if err != nil {
		return err
	}
	return c.putFile(ctx, groupPath, bytes.NewReader(raw), int64(len(raw)))
}

func (c *Client) ReadPushSubscriptions(ctx context.Context, groupID string) ([]storage.PushSubscription, error) {
	subscriptionsPath, err := c.pushSubscriptionsPath(groupID)
	if err != nil {
		return nil, err
	}
	raw, err := c.readFile(ctx, subscriptionsPath, 1<<20)
	if err != nil {
		return nil, err
	}
	var file struct {
		Version       int                        `json:"version"`
		Subscriptions []storage.PushSubscription `json:"subscriptions"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, err
	}
	return file.Subscriptions, nil
}

func (c *Client) WritePushSubscriptions(ctx context.Context, groupID string, subscriptions []storage.PushSubscription) error {
	subscriptionsPath, err := c.pushSubscriptionsPath(groupID)
	if err != nil {
		return err
	}
	if err := c.mkdir(ctx, path.Dir(subscriptionsPath)); err != nil {
		return err
	}
	raw, err := json.Marshal(struct {
		Version       int                        `json:"version"`
		Subscriptions []storage.PushSubscription `json:"subscriptions"`
	}{
		Version:       1,
		Subscriptions: subscriptions,
	})
	if err != nil {
		return err
	}
	return c.putFile(ctx, subscriptionsPath, bytes.NewReader(raw), int64(len(raw)))
}

func (c *Client) ReadIndex(ctx context.Context, groupID string) ([]byte, error) {
	indexPath, err := c.indexPath(groupID)
	if err != nil {
		return nil, err
	}
	return c.readFile(ctx, indexPath, c.cfg.MaxBytes)
}

func (c *Client) WriteIndex(ctx context.Context, groupID string, data []byte) error {
	indexPath, err := c.indexPath(groupID)
	if err != nil {
		return err
	}
	if err := c.mkdir(ctx, path.Dir(indexPath)); err != nil {
		return err
	}
	return c.putFile(ctx, indexPath, bytes.NewReader(data), int64(len(data)))
}

func (c *Client) WriteBlob(ctx context.Context, groupID string, clipID string, data io.ReadSeeker, size int64) error {
	blobPath, err := c.blobPath(groupID, clipID)
	if err != nil {
		return err
	}
	if err := c.mkdir(ctx, path.Dir(blobPath)); err != nil {
		return err
	}
	return c.putFile(ctx, blobPath, data, size)
}

func (c *Client) ReadBlob(ctx context.Context, groupID string, clipID string) (io.ReadCloser, int64, error) {
	blobPath, err := c.blobPath(groupID, clipID)
	if err != nil {
		return nil, 0, err
	}
	info, err := c.getFileInfo(ctx, blobPath)
	if err != nil {
		return nil, 0, err
	}
	if info.Size > c.cfg.MaxBytes {
		return nil, 0, fmt.Errorf("openlist file too large: %d", info.Size)
	}
	if info.RawURL == "" {
		return nil, 0, fmt.Errorf("openlist returned empty raw_url for %s", blobPath)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, info.RawURL, nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, 0, storage.ErrNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		resp.Body.Close()
		return nil, 0, fmt.Errorf("download failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return resp.Body, info.Size, nil
}

func (c *Client) DeleteBlob(ctx context.Context, groupID string, clipID string) error {
	blobPath, err := c.blobPath(groupID, clipID)
	if err != nil {
		return err
	}
	dir := path.Dir(blobPath)
	name := path.Base(blobPath)
	return c.doJSON(ctx, http.MethodPost, "/api/fs/remove", map[string]any{
		"dir":   dir,
		"names": []string{name},
	}, nil)
}

func (c *Client) groupPath(groupID string) (string, error) {
	if !groupIDPattern.MatchString(groupID) {
		return "", fmt.Errorf("invalid group id")
	}
	return joinPath(c.cfg.Root, "v1", "groups", groupID), nil
}

func (c *Client) groupMetadataPath(groupID string) (string, error) {
	groupPath, err := c.groupPath(groupID)
	if err != nil {
		return "", err
	}
	return joinPath(groupPath, "group.json"), nil
}

func (c *Client) indexPath(groupID string) (string, error) {
	groupPath, err := c.groupPath(groupID)
	if err != nil {
		return "", err
	}
	return joinPath(groupPath, "index.enc"), nil
}

func (c *Client) pushSubscriptionsPath(groupID string) (string, error) {
	groupPath, err := c.groupPath(groupID)
	if err != nil {
		return "", err
	}
	return joinPath(groupPath, "push-subscriptions.json"), nil
}

func (c *Client) blobPath(groupID string, clipID string) (string, error) {
	groupPath, err := c.groupPath(groupID)
	if err != nil {
		return "", err
	}
	if !clipIDPattern.MatchString(clipID) {
		return "", fmt.Errorf("invalid clip id")
	}
	month := clipID[:4] + "-" + clipID[4:6]
	return joinPath(groupPath, "blobs", month, clipID+".bin"), nil
}

func (c *Client) mkdir(ctx context.Context, dir string) error {
	err := c.doJSON(ctx, http.MethodPost, "/api/fs/mkdir", map[string]string{"path": dir}, nil)
	if err != nil && !strings.Contains(strings.ToLower(err.Error()), "exist") {
		return err
	}
	return nil
}

func (c *Client) putFile(ctx context.Context, filePath string, data io.ReadSeeker, size int64) error {
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := data.Seek(0, io.SeekStart); err != nil {
			return err
		}
		token, err := c.authToken(ctx)
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, c.cfg.BaseURL+"/api/fs/put", data)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", token)
		req.Header.Set("Client-Id", c.cfg.ClientID)
		req.Header.Set("File-Path", url.PathEscape(filePath))
		req.Header.Set("Content-Type", "application/octet-stream")
		req.Header.Set("Content-Length", fmt.Sprintf("%d", size))
		req.ContentLength = size
		resp, err := c.httpClient.Do(req)
		if err != nil {
			return err
		}
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
			resp.Body.Close()
			c.clearToken()
			continue
		}
		defer resp.Body.Close()
		return decodeOpenListResponse(resp, nil)
	}
	return errors.New("openlist upload failed after token refresh")
}

func (c *Client) readFile(ctx context.Context, filePath string, limit int64) ([]byte, error) {
	info, err := c.getFileInfo(ctx, filePath)
	if err != nil {
		return nil, err
	}
	if limit > 0 && info.Size > limit {
		return nil, fmt.Errorf("openlist file too large: %d", info.Size)
	}
	if info.RawURL == "" {
		return nil, fmt.Errorf("openlist returned empty raw_url for %s", filePath)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, info.RawURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, storage.ErrNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("download failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return readLimited(resp.Body, limit)
}

func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	if limit <= 0 {
		limit = 50 * 1024 * 1024
	}
	raw, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("openlist file too large: %d", len(raw))
	}
	return raw, nil
}

type fileInfo struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	IsDir  bool   `json:"is_dir"`
	RawURL string `json:"raw_url"`
}

func (c *Client) getFileInfo(ctx context.Context, filePath string) (fileInfo, error) {
	var data fileInfo
	err := c.doJSON(ctx, http.MethodPost, "/api/fs/get", map[string]any{
		"path":     filePath,
		"password": "",
		"page":     1,
		"per_page": 0,
		"refresh":  false,
	}, &data)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			return fileInfo{}, storage.ErrNotFound
		}
		return fileInfo{}, err
	}
	return data, nil
}

func (c *Client) doJSON(ctx context.Context, method, endpoint string, body any, out any) error {
	token, err := c.authToken(ctx)
	if err != nil {
		return err
	}

	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.cfg.BaseURL+endpoint, payload)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", token)
	req.Header.Set("Client-Id", c.cfg.ClientID)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		c.clearToken()
		return c.doJSON(ctx, method, endpoint, body, out)
	}
	return decodeOpenListResponse(resp, out)
}

func (c *Client) authToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	if c.token != "" && time.Now().Before(c.tokenUntil) {
		token := c.token
		c.mu.Unlock()
		return token, nil
	}
	c.mu.Unlock()

	payload, err := json.Marshal(map[string]string{
		"username": c.cfg.Username,
		"password": c.cfg.Password,
		"otp_code": c.cfg.OTPCode,
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.BaseURL+"/api/auth/login", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Client-Id", c.cfg.ClientID)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var data struct {
		Token string `json:"token"`
	}
	if err := decodeOpenListResponse(resp, &data); err != nil {
		return "", err
	}
	if data.Token == "" {
		return "", errors.New("openlist login returned empty token")
	}
	c.mu.Lock()
	c.token = data.Token
	c.tokenUntil = time.Now().Add(45 * time.Hour)
	c.mu.Unlock()
	return data.Token, nil
}

func (c *Client) clearToken() {
	c.mu.Lock()
	c.token = ""
	c.tokenUntil = time.Time{}
	c.mu.Unlock()
}

func decodeOpenListResponse(resp *http.Response, out any) error {
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("openlist status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var envelope struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return fmt.Errorf("openlist invalid json: %w", err)
	}
	if envelope.Code != 200 {
		return fmt.Errorf("openlist code=%d message=%s", envelope.Code, envelope.Message)
	}
	if out != nil && len(envelope.Data) > 0 && string(envelope.Data) != "null" {
		if err := json.Unmarshal(envelope.Data, out); err != nil {
			return err
		}
	}
	return nil
}

func cleanRoot(root string) string {
	root = "/" + strings.Trim(root, "/")
	clean := path.Clean(root)
	if clean == "." || clean == "/" {
		return "/clipboard"
	}
	return clean
}

func joinPath(root string, elems ...string) string {
	parts := append([]string{root}, elems...)
	return path.Clean(path.Join(parts...))
}

func ETag(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func ContentDisposition(filename string) string {
	return mime.FormatMediaType("attachment", map[string]string{"filename": filename})
}
