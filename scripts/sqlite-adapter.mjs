/** Development/test adapter for the subset of D1 used by the application. */
import {DatabaseSync} from 'node:sqlite';
export class SQLiteD1 {
  constructor(path=':memory:'){this.db=new DatabaseSync(path);this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');}
  exec(sql){this.db.exec(sql);}
  prepare(sql){const db=this.db;let args=[];return {
    bind(...values){args=values;return this;},
    async first(column){const row=db.prepare(sql).get(...args);return row?(column?row[column]:row):null;},
    async all(){return {results:db.prepare(sql).all(...args),success:true};},
    async run(){const r=db.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
  };}
  async batch(statements){this.db.exec('BEGIN IMMEDIATE');try{const results=[];for(const s of statements)results.push(await s.run());this.db.exec('COMMIT');return results;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  close(){this.db.close();}
}
