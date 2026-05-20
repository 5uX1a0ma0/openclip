package storage

import (
	"context"
	"encoding/json"
	"errors"
	"io"
)

var ErrNotFound = errors.New("not found")

type Group struct {
	Version      int             `json:"version"`
	GroupID      string          `json:"groupId"`
	Name         string          `json:"name"`
	KeyHash      string          `json:"keyHash"`
	PublicKeyJWK json.RawMessage `json:"publicKeyJwk"`
	CreatedAt    int64           `json:"createdAt"`
	UpdatedAt    int64           `json:"updatedAt"`
}

type Store interface {
	Ensure(ctx context.Context) error
	ReadGroup(ctx context.Context, groupID string) (Group, error)
	WriteGroup(ctx context.Context, group Group) error
	ReadIndex(ctx context.Context, groupID string) ([]byte, error)
	WriteIndex(ctx context.Context, groupID string, data []byte) error
	WriteBlob(ctx context.Context, groupID string, clipID string, data io.Reader, size int64) error
	ReadBlob(ctx context.Context, groupID string, clipID string) (io.ReadCloser, int64, error)
	DeleteBlob(ctx context.Context, groupID string, clipID string) error
}
