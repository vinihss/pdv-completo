package repository

import "encoding/json"

func encodeFeatures(m map[string]bool) (string, error) {
	if len(m) == 0 {
		return "{}", nil
	}
	b, err := json.Marshal(m)
	return string(b), err
}

func decodeFeatures(s string) (map[string]bool, error) {
	if s == "" {
		return map[string]bool{}, nil
	}
	var m map[string]bool
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil, err
	}
	return m, nil
}

func encodeLimits(m map[string]int64) (string, error) {
	if len(m) == 0 {
		return "{}", nil
	}
	b, err := json.Marshal(m)
	return string(b), err
}

func decodeLimits(s string) (map[string]int64, error) {
	if s == "" {
		return map[string]int64{}, nil
	}
	var m map[string]int64
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil, err
	}
	return m, nil
}
