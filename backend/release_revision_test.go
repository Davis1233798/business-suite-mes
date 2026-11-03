package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestHealthReportsOnlyValidBuildRevision(t *testing.T) {
	valid := strings.Repeat("a", 40)
	for _, tc := range []struct{ input, want string }{{valid, valid}, {"", "unknown"}, {"invalid", "unknown"}, {strings.Repeat("A", 40), "unknown"}, {valid + "x", "unknown"}} {
		if got := validatedReleaseRevision(tc.input); got != tc.want {
			t.Fatalf("revision %q = %q", tc.input, got)
		}
	}
	a := appForTest(t)
	old := releaseSHA
	releaseSHA = valid
	t.Cleanup(func() { releaseSHA = old })
	w := request(a, http.MethodGet, "/api/health", nil)
	var response struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != http.StatusOK || response.Data["revision"] != valid {
		t.Fatalf("health revision %d %v %s", w.Code, err, w.Body.String())
	}
}
