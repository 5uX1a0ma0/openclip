package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"openlist-clipboard/internal/config"
	"openlist-clipboard/internal/openlist"
	"openlist-clipboard/internal/server"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--generate-vapid" {
		publicKey, privateKey, err := server.GenerateVAPIDKeys()
		if err != nil {
			log.Fatalf("generate vapid: %v", err)
		}
		fmt.Printf("CLIPBOARD_VAPID_PUBLIC_KEY=%s\n", publicKey)
		fmt.Printf("CLIPBOARD_VAPID_PRIVATE_KEY=%s\n", privateKey)
		fmt.Println("CLIPBOARD_VAPID_SUBJECT=mailto:admin@example.com")
		return
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	store := openlist.NewClient(openlist.Config{
		BaseURL:  cfg.OpenListBaseURL,
		Username: cfg.OpenListUsername,
		Password: cfg.OpenListPassword,
		OTPCode:  cfg.OpenListOTPCode,
		Root:     cfg.OpenListRoot,
		ClientID: cfg.OpenListClientID,
		Timeout:  45 * time.Second,
		MaxBytes: cfg.MaxBlobBytes,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	if err := store.Ensure(ctx); err != nil {
		cancel()
		log.Fatalf("openlist init: %v", err)
	}
	cancel()

	router := server.New(server.Config{
		AllowedOrigin:     cfg.AllowedOrigin,
		CreatePassword:    cfg.CreatePassword,
		MaxBlobBytes:      cfg.MaxBlobBytes,
		TrustProxyHeaders: cfg.TrustProxyHeaders,
		StaticDir:         cfg.StaticDir,
		VAPIDPublicKey:    cfg.VAPIDPublicKey,
		VAPIDPrivateKey:   cfg.VAPIDPrivateKey,
		VAPIDSubject:      cfg.VAPIDSubject,
	}, store)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	go func() {
		log.Printf("listening on %s", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
