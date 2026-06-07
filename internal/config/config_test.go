package config

import "testing"

func TestPlaceholderSecret(t *testing.T) {
	for _, value := range []string{"change-this-create-password", "change-this-openlist-password", "changeme", "password"} {
		if !placeholderSecret(value) {
			t.Fatalf("placeholderSecret(%q)=false", value)
		}
	}
	if placeholderSecret("correct-horse-battery-staple") {
		t.Fatal("strong-looking value was treated as placeholder")
	}
}

func TestEnvBool(t *testing.T) {
	t.Setenv("CLIPBOARD_TRUST_PROXY_HEADERS", "true")
	if !envBool("CLIPBOARD_TRUST_PROXY_HEADERS", false) {
		t.Fatal("true env bool parsed as false")
	}
	t.Setenv("CLIPBOARD_TRUST_PROXY_HEADERS", "false")
	if envBool("CLIPBOARD_TRUST_PROXY_HEADERS", true) {
		t.Fatal("false env bool parsed as true")
	}
}
