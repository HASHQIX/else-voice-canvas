import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

it('adds optional speaker metadata to an existing transcript without relabeling or losing history', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'else-speaker-migration-'));
  const filename = path.join(directory, 'legacy.sqlite');
  const legacy = new Database(filename);
  legacy.exec('CREATE TABLE speech_segments(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,session_id TEXT NOT NULL,text TEXT NOT NULL,is_final INTEGER NOT NULL,created_at TEXT NOT NULL)');
  legacy.prepare('INSERT INTO speech_segments VALUES(?,?,?,?,?,?,?)').run('s:0','owner','project','s','Earlier words.',1,'2026-09-30T10:00:00Z');
  legacy.close();
  vi.stubEnv('DATABASE_PATH', filename);
  let store: typeof import('../server/db.js') | undefined;
  try {
    store = await import('../server/db.js');
    expect(store.speechSegmentsFor('owner','project')).toEqual([{id:'s:0',text:'Earlier words.',final:true,createdAt:'2026-09-30T10:00:00Z'}]);
    store.db.close(); vi.resetModules();
    store = await import('../server/db.js');
    expect(store.speechSegmentsFor('owner','project')).toHaveLength(1);
    expect((store.db.pragma('table_info(speech_segments)') as any[]).filter(column => column.name === 'speaker_label')).toHaveLength(1);
  } finally {
    if (store?.db.open) store.db.close();
    vi.unstubAllEnvs(); fs.rmSync(directory,{recursive:true,force:true});
  }
});
