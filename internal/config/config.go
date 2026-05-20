package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Addr             string
	AllowedOrigin    string
	CreatePassword   string
	MaxBlobBytes     int64
	StaticDir        string
	OpenListBaseURL  string
	OpenListUsername string
	OpenListPassword string
	OpenListOTPCode  string
	OpenListRoot     string
	OpenListClientID string
}

func Load() (Config, error) {
	if err := loadDotEnv(".env"); err != nil {
		return Config{}, err
	}

	cfg := Config{
		Addr:             env("CLIPBOARD_ADDR", ":8080"),
		AllowedOrigin:    os.Getenv("CLIPBOARD_ALLOWED_ORIGIN"),
		CreatePassword:   os.Getenv("CLIPBOARD_CREATE_PASSWORD"),
		MaxBlobBytes:     envInt64("CLIPBOARD_MAX_BLOB_BYTES", 50*1024*1024),
		StaticDir:        env("CLIPBOARD_STATIC_DIR", "frontend/dist"),
		OpenListBaseURL:  strings.TrimRight(os.Getenv("OPENLIST_BASE_URL"), "/"),
		OpenListUsername: os.Getenv("OPENLIST_USERNAME"),
		OpenListPassword: os.Getenv("OPENLIST_PASSWORD"),
		OpenListOTPCode:  os.Getenv("OPENLIST_OTP_CODE"),
		OpenListRoot:     cleanRoot(env("OPENLIST_ROOT", "/clipboard")),
		OpenListClientID: env("OPENLIST_CLIENT_ID", "openlist-clipboard-gateway"),
	}

	if cfg.OpenListBaseURL == "" {
		return Config{}, errors.New("OPENLIST_BASE_URL is required")
	}
	if cfg.OpenListUsername == "" {
		return Config{}, errors.New("OPENLIST_USERNAME is required")
	}
	if cfg.OpenListPassword == "" {
		return Config{}, errors.New("OPENLIST_PASSWORD is required")
	}
	if cfg.CreatePassword == "" {
		return Config{}, errors.New("CLIPBOARD_CREATE_PASSWORD is required")
	}
	if cfg.MaxBlobBytes <= 0 {
		return Config{}, errors.New("CLIPBOARD_MAX_BLOB_BYTES must be positive")
	}

	return cfg, nil
}

func loadDotEnv(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read %s: %w", path, err)
	}
	for lineNumber, rawLine := range strings.Split(string(raw), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return fmt.Errorf("%s:%d invalid env line", path, lineNumber+1)
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		if key == "" {
			return fmt.Errorf("%s:%d empty env key", path, lineNumber+1)
		}
		if os.Getenv(key) == "" {
			if err := os.Setenv(key, value); err != nil {
				return fmt.Errorf("set %s: %w", key, err)
			}
		}
	}
	return nil
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt64(key string, fallback int64) int64 {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func cleanRoot(root string) string {
	root = strings.TrimSpace(root)
	if root == "" || root == "/" {
		return "/clipboard"
	}
	root = "/" + strings.Trim(root, "/")
	parts := strings.Split(root, "/")
	cleaned := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			continue
		}
		cleaned = append(cleaned, part)
	}
	if len(cleaned) == 0 {
		return "/clipboard"
	}
	return "/" + strings.Join(cleaned, "/")
}
