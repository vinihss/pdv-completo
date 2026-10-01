package main

import "testing"

func TestValidateCloudConfigRequiresHTTPSAndCredentials(t *testing.T) {
	base := CloudConfig{
		Enabled:   true,
		BaseURL:   "https://api.example.com",
		StationID: "store-01-station-01",
		Token:     "secret",
	}
	if err := validateCloudConfig(normalizeCloudConfig(base)); err != nil {
		t.Fatalf("configuração válida rejeitada: %v", err)
	}

	insecure := base
	insecure.BaseURL = "http://api.example.com"
	if err := validateCloudConfig(normalizeCloudConfig(insecure)); err == nil {
		t.Fatal("HTTP público deveria ser rejeitado")
	}

	local := base
	local.BaseURL = "http://127.0.0.1:9999"
	if err := validateCloudConfig(normalizeCloudConfig(local)); err != nil {
		t.Fatalf("HTTP local deveria ser permitido: %v", err)
	}
}

func TestCloudEndpointJoinsBaseAndPath(t *testing.T) {
	got, err := cloudEndpoint("https://api.example.com/", "/v1/print-events?limit=20")
	if err != nil {
		t.Fatal(err)
	}
	if got.String() != "https://api.example.com/v1/print-events?limit=20" {
		t.Fatalf("endpoint = %q", got.String())
	}
}

func TestNormalizeCloudConfig(t *testing.T) {
	got := normalizeCloudConfig(CloudConfig{})
	if got.EventsPath == "" || got.AckPath == "" || got.StatusPath == "" {
		t.Fatalf("paths padrão incompletos: %+v", got)
	}
	if got.PollIntervalSecs <= 0 || got.BatchSize <= 0 || got.RequestTimeoutSecs <= 0 {
		t.Fatalf("defaults inválidos: %+v", got)
	}
	if normalizeCloudConfig(CloudConfig{BatchSize: 1000}).BatchSize != 20 {
		t.Fatal("batch_size acima do limite deveria voltar ao padrão")
	}
}
