package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"openlist-clipboard/internal/storage"
)

const defaultChunkPlainBytes = 4 * 1024 * 1024
const maxPushSubscriptionsPerGroup = 64

type PushSender interface {
	Send(ctx context.Context, subscription storage.PushSubscription, payload []byte) (remove bool, err error)
}

type WebPushSender struct {
	publicKey  string
	privateKey string
	subject    string
}

func NewWebPushSender(publicKey, privateKey, subject string) *WebPushSender {
	return &WebPushSender{
		publicKey:  publicKey,
		privateKey: privateKey,
		subject:    subject,
	}
}

func GenerateVAPIDKeys() (string, string, error) {
	privateKey, publicKey, err := webpush.GenerateVAPIDKeys()
	return publicKey, privateKey, err
}

func (s *WebPushSender) Send(ctx context.Context, subscription storage.PushSubscription, payload []byte) (bool, error) {
	response, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{
		Endpoint: subscription.Endpoint,
		Keys: webpush.Keys{
			P256dh: subscription.P256DH,
			Auth:   subscription.Auth,
		},
	}, &webpush.Options{
		Subscriber:      s.subject,
		VAPIDPublicKey:  s.publicKey,
		VAPIDPrivateKey: s.privateKey,
		TTL:             60,
	})
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return false, nil
	}
	if response.StatusCode == http.StatusGone || response.StatusCode == http.StatusNotFound {
		return true, nil
	}
	return false, fmt.Errorf("web push returned status %d", response.StatusCode)
}

func (a *API) postPushSubscription(w http.ResponseWriter, r *http.Request, groupID string) {
	if a.push == nil {
		writeError(w, http.StatusNotImplemented, "web push is not configured")
		return
	}
	var req struct {
		ClientID string `json:"clientId"`
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256DH string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
	}
	if err := decodeJSON(r, &req, 16*1024); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	subscription, err := cleanPushSubscription(req.ClientID, req.Endpoint, req.Keys.P256DH, req.Keys.Auth)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid push subscription")
		return
	}

	lock := a.indexLock(groupID)
	lock.Lock()
	defer lock.Unlock()

	subscriptions, err := a.readPushSubscriptions(r.Context(), groupID)
	if err != nil {
		writeError(w, http.StatusBadGateway, "openlist read failed")
		return
	}
	now := time.Now().UnixMilli()
	subscription.CreatedAt = now
	subscription.UpdatedAt = now
	replaced := false
	for i := range subscriptions {
		if subscriptions[i].Endpoint == subscription.Endpoint {
			subscription.CreatedAt = subscriptions[i].CreatedAt
			subscriptions[i] = subscription
			replaced = true
			break
		}
	}
	if !replaced {
		subscriptions = append(subscriptions, subscription)
	}
	subscriptions = trimPushSubscriptions(subscriptions)
	if err := a.store.WritePushSubscriptions(r.Context(), groupID, subscriptions); err != nil {
		writeError(w, http.StatusBadGateway, "openlist write failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) deletePushSubscription(w http.ResponseWriter, r *http.Request, groupID string) {
	var req struct {
		ClientID string `json:"clientId"`
		Endpoint string `json:"endpoint"`
	}
	if err := decodeJSON(r, &req, 16*1024); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	endpoint := strings.TrimSpace(req.Endpoint)
	if endpoint == "" {
		writeError(w, http.StatusBadRequest, "endpoint is required")
		return
	}
	lock := a.indexLock(groupID)
	lock.Lock()
	defer lock.Unlock()

	subscriptions, err := a.readPushSubscriptions(r.Context(), groupID)
	if err != nil {
		writeError(w, http.StatusBadGateway, "openlist read failed")
		return
	}
	next := subscriptions[:0]
	for _, subscription := range subscriptions {
		if subscription.Endpoint == endpoint || (req.ClientID != "" && subscription.ClientID == req.ClientID) {
			continue
		}
		next = append(next, subscription)
	}
	if err := a.store.WritePushSubscriptions(r.Context(), groupID, next); err != nil {
		writeError(w, http.StatusBadGateway, "openlist write failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) notifyPushSubscribers(groupID, sourceClientID, indexHash string) {
	if a.push == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = a.sendPushNotifications(ctx, groupID, sourceClientID, indexHash)
	}()
}

func (a *API) sendPushNotifications(ctx context.Context, groupID, sourceClientID, indexHash string) error {
	lock := a.indexLock(groupID)
	lock.Lock()
	subscriptions, err := a.readPushSubscriptions(ctx, groupID)
	lock.Unlock()
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]string{
		"title": "OpenList Clipboard",
		"body":  "剪贴板内容已更新",
		"groupId": groupID,
		"hash": indexHash,
	})
	if err != nil {
		return err
	}
	removeEndpoints := make(map[string]bool)
	for _, subscription := range subscriptions {
		if sourceClientID != "" && subscription.ClientID == sourceClientID {
			continue
		}
		remove, err := a.push.Send(ctx, subscription, payload)
		if err != nil && !remove {
			continue
		}
		if remove {
			removeEndpoints[subscription.Endpoint] = true
		}
	}
	if len(removeEndpoints) == 0 {
		return nil
	}

	lock.Lock()
	defer lock.Unlock()
	subscriptions, err = a.readPushSubscriptions(ctx, groupID)
	if err != nil {
		return err
	}
	next := subscriptions[:0]
	for _, subscription := range subscriptions {
		if removeEndpoints[subscription.Endpoint] {
			continue
		}
		next = append(next, subscription)
	}
	return a.store.WritePushSubscriptions(ctx, groupID, next)
}

func trimPushSubscriptions(subscriptions []storage.PushSubscription) []storage.PushSubscription {
	if len(subscriptions) <= maxPushSubscriptionsPerGroup {
		return subscriptions
	}
	return append([]storage.PushSubscription(nil), subscriptions[len(subscriptions)-maxPushSubscriptionsPerGroup:]...)
}

func (a *API) readPushSubscriptions(ctx context.Context, groupID string) ([]storage.PushSubscription, error) {
	subscriptions, err := a.store.ReadPushSubscriptions(ctx, groupID)
	if errors.Is(err, storage.ErrNotFound) {
		return nil, nil
	}
	return subscriptions, err
}

func cleanPushSubscription(clientID, endpoint, p256dh, auth string) (storage.PushSubscription, error) {
	subscription := storage.PushSubscription{
		ClientID: strings.TrimSpace(clientID),
		Endpoint: strings.TrimSpace(endpoint),
		P256DH: strings.TrimSpace(p256dh),
		Auth: strings.TrimSpace(auth),
	}
	if subscription.Endpoint == "" || subscription.P256DH == "" || subscription.Auth == "" {
		return storage.PushSubscription{}, errors.New("missing subscription fields")
	}
	if !strings.HasPrefix(subscription.Endpoint, "https://") {
		return storage.PushSubscription{}, errors.New("endpoint must be https")
	}
	if len(subscription.Endpoint) > 4096 || len(subscription.P256DH) > 512 || len(subscription.Auth) > 256 || len(subscription.ClientID) > 128 {
		return storage.PushSubscription{}, errors.New("subscription field too long")
	}
	if bytes.ContainsAny([]byte(subscription.ClientID), "\x00\r\n") {
		return storage.PushSubscription{}, errors.New("invalid client id")
	}
	return subscription, nil
}
