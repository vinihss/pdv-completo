package crypto_test

import (
	"context"
	"testing"

	"github.com/example/license-platform/internal/crypto"
)

func TestInMemoryKeyProvider_GeneratesStableKeyPerInstance(t *testing.T) {
	kp, err := crypto.NewInMemoryKeyProvider("test-key")
	if err != nil {
		t.Fatalf("não deveria falhar ao gerar chave: %v", err)
	}

	_, keyID1, _ := kp.PrivateKey(context.Background())
	_, keyID2, _ := kp.PrivateKey(context.Background())
	if keyID1 != "test-key" || keyID2 != "test-key" {
		t.Fatalf("key_id deveria ser estável, obteve %q e %q", keyID1, keyID2)
	}

	pub1, _, _ := kp.PublicKey(context.Background())
	pub2, _, _ := kp.PublicKey(context.Background())
	if string(pub1) != string(pub2) {
		t.Fatal("chave pública deveria ser estável dentro da mesma instância")
	}
}

func TestEd25519Signer_SignAndVerify_RoundTrip(t *testing.T) {
	kp, err := crypto.NewInMemoryKeyProvider("test-key")
	if err != nil {
		t.Fatalf("não deveria falhar ao gerar chave: %v", err)
	}
	signer := crypto.NewEd25519Signer(kp)

	payload := []byte(`{"license_id":"lic-1"}`)
	sig, keyID, err := signer.Sign(payload)
	if err != nil {
		t.Fatalf("assinatura não deveria falhar: %v", err)
	}
	if keyID != "test-key" {
		t.Fatalf("esperava key_id 'test-key', obteve %q", keyID)
	}

	pub, _, _ := kp.PublicKey(context.Background())
	if err := crypto.Verify(pub, payload, sig); err != nil {
		t.Fatalf("verificação deveria passar para assinatura válida: %v", err)
	}
}

func TestVerify_RejectsTamperedPayload(t *testing.T) {
	kp, _ := crypto.NewInMemoryKeyProvider("test-key")
	signer := crypto.NewEd25519Signer(kp)

	sig, _, _ := signer.Sign([]byte(`{"license_id":"lic-1"}`))
	pub, _, _ := kp.PublicKey(context.Background())

	tampered := []byte(`{"license_id":"lic-2"}`)
	if err := crypto.Verify(pub, tampered, sig); err == nil {
		t.Fatal("verificação deveria falhar para payload adulterado")
	}
}

func TestVerify_RejectsWrongPublicKey(t *testing.T) {
	kp1, _ := crypto.NewInMemoryKeyProvider("key-1")
	kp2, _ := crypto.NewInMemoryKeyProvider("key-2")
	signer := crypto.NewEd25519Signer(kp1)

	payload := []byte(`{"license_id":"lic-1"}`)
	sig, _, _ := signer.Sign(payload)

	wrongPub, _, _ := kp2.PublicKey(context.Background())
	if err := crypto.Verify(wrongPub, payload, sig); err == nil {
		t.Fatal("verificação deveria falhar com chave pública incorreta")
	}
}
