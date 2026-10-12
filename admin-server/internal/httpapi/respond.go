package httpapi

import (
	"encoding/json"
	"net/http"
)

// errorEnvelope é o formato único de erro da API: {"error":{"code","message"}}.
type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, errCode, message string) {
	writeJSON(w, code, errorEnvelope{Error: errorBody{Code: errCode, Message: message}})
}
