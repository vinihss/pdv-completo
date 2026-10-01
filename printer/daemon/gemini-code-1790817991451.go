package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"time"

	go_bolt "go.etcd.io/bbolt"
)

type PrintJob struct {
	ID        string    `json:"id"`
	Printer   string    `json:"printer"`   // Ex: "cozinha", "caixa" ou IP
	Payload   []byte    `json:"payload"`   // Comandos ESC/POS gerados
	Retries   int       `json:"retries"`
	CreatedAt time.Time `json:"created_at"`
}

type Spooler struct {
	db *go_bolt.DB
}

var bucketJobs = []byte("print_jobs")

func NewSpooler(dbPath string) (*Spooler, error) {
	db, err := go_bolt.Open(dbPath, 0600, &go_bolt.Options{Timeout: 1 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("erro ao abrir banco de dados local: %w", err)
	}

	err = db.Update(func(tx *go_bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(bucketJobs)
		return err
	})
	if err != nil {
		return nil, err
	}

	return &Spooler{db: db}, nil
}

// EnqueueJob grava o trabalho de impressão no disco de forma atómica
func (s *Spooler) EnqueueJob(job PrintJob) error {
	return s.db.Update(func(tx *go_bolt.Tx) error {
		b := tx.Bucket(bucketJobs)
		data, err := json.Marshal(job)
		if err != nil {
			return err
		}
		return b.Put([]byte(job.ID), data)
	})
}

// ProcessQueue consome a fila e tenta enviar para o transporte físico
func (s *Spooler) ProcessQueue(transport Transport) {
	ticker := time.NewTicker(2 * time.Second)
	for range ticker.C {
		var jobs []PrintJob

		// Ler trabalhos pendentes
		s.db.View(func(tx *go_bolt.Tx) error {
			b := tx.Bucket(bucketJobs)
			return b.ForEach(func(k, v []byte) error {
				var job PrintJob
				if err := json.Unmarshal(v, &job); err == nil {
					jobs = append(jobs, job)
				}
				return nil
			})
		})

		// Processar cada trabalho
		for _, job := range jobs {
			err := transport.Send(job.Printer, job.Payload)
			if err == nil {
				// Sucesso: remove da fila local
				s.DeleteJob(job.ID)
				log.Printf("[SPOOLER] Impressão %s enviada com sucesso para %s\n", job.ID, job.Printer)
			} else {
				// Falha: incrementa retentativas
				log.Printf("[SPOOLER] Erro ao enviar %s para %s: %v (Tentativa %d)\n", job.ID, job.Printer, err, job.Retries+1)
				s.IncrementRetry(job)
			}
		}
	}
}

func (s *Spooler) DeleteJob(id string) error {
	return s.db.Update(func(tx *go_bolt.Tx) error {
		b := tx.Bucket(bucketJobs)
		return b.Delete([]byte(id))
	})
}

func (s *Spooler) IncrementRetry(job PrintJob) error {
	job.Retries++
	return s.EnqueueJob(job)
}

func (s *Spooler) Close() {
	if s.db != nil {
		s.db.Close()
	}
}