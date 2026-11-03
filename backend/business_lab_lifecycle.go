package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

var errBusinessLabCapacity = errors.New("business lab capacity reached")

// businessLabManager owns only private directories it creates under root.
type businessLabManager struct {
	root  string
	slots chan struct{}
}
type businessLab struct {
	app       *App
	directory string
	manager   *businessLabManager
	once      sync.Once
	closeErr  error
}

func newBusinessLabManager(root string, limit int) *businessLabManager {
	if limit < 1 {
		limit = 1
	}
	return &businessLabManager{root: root, slots: make(chan struct{}, limit)}
}
func (m *businessLabManager) acquire(ctx context.Context) (*businessLab, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case m.slots <- struct{}{}:
	default:
		return nil, errBusinessLabCapacity
	}
	release := true
	defer func() {
		if release {
			<-m.slots
		}
	}()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(m.root, 0700); err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp(m.root, "business-lab-")
	if err != nil {
		return nil, err
	}
	db, err := openDB(filepath.Join(dir, "station.sqlite"))
	if err != nil {
		if cleanupErr := os.RemoveAll(dir); cleanupErr != nil {
			return nil, errors.Join(err, cleanupErr)
		}
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, errors.Join(err, db.Close(), os.RemoveAll(dir))
	}
	lab := &businessLab{app: &App{db: db}, directory: dir, manager: m}
	release = false
	return lab, nil
}
func (lab *businessLab) close() error {
	lab.once.Do(func() {
		defer func() { <-lab.manager.slots }()
		if err := lab.app.db.Close(); err != nil {
			lab.closeErr = err
			return
		}
		lab.closeErr = os.RemoveAll(lab.directory)
	})
	return lab.closeErr
}
