import knex, { StaticConnectionConfig } from 'knex'
import log from '../lib/log'
import { wait } from '../lib/helpers'

export type ConnectionMode = 'read' | 'write';
export type DBConnection = knex | knex.Transaction;

export const poolCache: { read: null | knex; write: null | knex; } = {
  read: null,
  write: null,
}

interface PoolConfig {
  min: number;
  max: number;
}

export const initConnectionPool = (mode: ConnectionMode, config?: PoolConfig) => {
  if (!poolCache[mode]) {
    log.info(`[postgres] creating connection: ${mode}`)
    poolCache[mode] = createConnectionPool(mode, config)
  }
}

export const getConnectionPool = (mode: ConnectionMode): knex => {
  return poolCache[mode]!
}

export const releaseConnectionPool = async (
    mode?: ConnectionMode,
): Promise<void> => {
  if (mode) {
    if (poolCache[mode]) {
      log.info(`[postgres] destroying connection: ${mode}`)
      await poolCache[mode]!.destroy()
      poolCache[mode] = null
    }
  } else {
    await Promise.all([
      releaseConnectionPool('read'),
      releaseConnectionPool('write'),
    ])
    await wait(200)
  }
}

export const createConnectionPool = (mode: ConnectionMode, { min, max }: PoolConfig = { min: 1, max: 10 }): knex => {
  const hostDisplayName = `${process.env.DATABASE_USER}@${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT}`

  log.info(`[postgres] connecting to db: ${hostDisplayName}`)

  const client = knex({
    client: 'pg',
    pool: {
      min,
      max,
      acquireTimeoutMillis: 20000,
      idleTimeoutMillis: 30000,
      reapIntervalMillis: 40000,
    },
    connection: async (): Promise<StaticConnectionConfig> => {
      return ({
        host: process.env.DATABASE_HOST,
        port: Number(process.env.DATABASE_PORT),
        user: process.env.DATABASE_USER,
        database: process.env.DATABASE_NAME,
        password: process.env.DATABASE_PASSWORD,
        expirationChecker: () => true,
      })
    },
  })

  return client
}

interface UpsertOptions<T = object[]> {
  table: string;
  conflictKeys: string[];
  rows: T;
  transaction?: knex.Transaction;
}

export const upsert = (connection: DBConnection, { table, conflictKeys, rows, transaction }: UpsertOptions) => {
  const updateFields = Object.keys(rows[0])
      .filter((field) => !conflictKeys.includes(field))
      .map((field) => `${field} = excluded.${field}`)
      .join(',')

  const query = connection.insert(rows).into(table)

  if (transaction) {
    query.transacting(transaction)
  }

  const { sql, bindings } = query.toSQL()
  const upsertSql = sql.concat(` ON CONFLICT (${conflictKeys.map((key) => `"${key}"`).join(',')}) DO UPDATE SET ${updateFields};`)

  return connection.raw(upsertSql, bindings)
}
