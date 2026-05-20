package main

import (
	"context"
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
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	if err := store.Ensure(ctx); err != nil {
		cancel()
		log.Fatalf("openlist init: %v", err)
	}
	cancel()

	router := server.New(server.Config{
		AllowedOrigin:  cfg.AllowedOrigin,
		CreatePassword: cfg.CreatePassword,
		MaxBlobBytes:   cfg.MaxBlobBytes,
		StaticDir:      cfg.StaticDir,
	}, store)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
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
