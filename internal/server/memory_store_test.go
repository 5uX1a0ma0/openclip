package server

import (
	"bytes"
	"context"
	"io"
	"sync"

	"openlist-clipboard/internal/storage"
)

type memoryStore struct {
	mu    sync.Mutex
	group map[string]storage.Group
	index map[string][]byte
	blob  map[string]map[string][]byte
}

func newMemoryStore() *memoryStore {
	return &memoryStore{
		group: make(map[string]storage.Group),
		index: make(map[string][]byte),
		blob:  make(map[string]map[string][]byte),
	}
}

func (m *memoryStore) Ensure(context.Context) error {
	return nil
}

func (m *memoryStore) ReadGroup(_ context.Context, groupID string) (storage.Group, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	group, ok := m.group[groupID]
	if !ok {
		return storage.Group{}, storage.ErrNotFound
	}
	group.PublicKeyJWK = append([]byte(nil), group.PublicKeyJWK...)
	return group, nil
}

func (m *memoryStore) WriteGroup(_ context.Context, group storage.Group) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	group.PublicKeyJWK = append([]byte(nil), group.PublicKeyJWK...)
	m.group[group.GroupID] = group
	return nil
}

func (m *memoryStore) ReadIndex(_ context.Context, groupID string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	raw, ok := m.index[groupID]
	if !ok {
		return nil, storage.ErrNotFound
	}
	return append([]byte(nil), raw...), nil
}

func (m *memoryStore) WriteIndex(_ context.Context, groupID string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.index[groupID] = append([]byte(nil), data...)
	return nil
}

func (m *memoryStore) WriteBlob(_ context.Context, groupID string, clipID string, data io.Reader, _ int64) error {
	raw, err := io.ReadAll(data)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.blob[groupID] == nil {
		m.blob[groupID] = make(map[string][]byte)
	}
	m.blob[groupID][clipID] = raw
	return nil
}

func (m *memoryStore) ReadBlob(_ context.Context, groupID string, clipID string) (io.ReadCloser, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	raw, ok := m.blob[groupID][clipID]
	if !ok {
		return nil, 0, storage.ErrNotFound
	}
	return io.NopCloser(bytes.NewReader(raw)), int64(len(raw)), nil
}

func (m *memoryStore) DeleteBlob(_ context.Context, groupID string, clipID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.blob[groupID], clipID)
	return nil
}
