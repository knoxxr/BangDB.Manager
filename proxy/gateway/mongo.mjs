// MongoDB adapter. Documents travel as relaxed Extended JSON so ObjectId,
// Date, Decimal128 and binary values survive a round trip through the app.
const MAX = 1000;

export async function mongodb(conn) {
  const { MongoClient, BSON } = await import('mongodb');
  const { EJSON } = BSON;
  const uri = conn.uri || `mongodb://${conn.user ? `${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password ?? '')}@` : ''}${conn.host || '127.0.0.1'}:${Number(conn.port) || 27017}/${conn.authSource ? `?authSource=${encodeURIComponent(conn.authSource)}` : ''}`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 4, tls: conn.ssl || undefined, tlsAllowInvalidCertificates: conn.ssl && conn.sslInsecure ? true : undefined });
  await client.connect();
  const out = (v) => EJSON.serialize(v, { relaxed: true });
  const inp = (v) => (v === undefined || v === null ? v : EJSON.deserialize(v, { relaxed: true }));
  const dbOf = (b) => client.db(b.database || conn.database || 'test');
  const coll = (b) => dbOf(b).collection(b.collection);

  const ops = {
    async databases() {
      const r = await client.db('admin').admin().listDatabases();
      return r.databases.map((d) => ({ name: d.name, size: d.sizeOnDisk, empty: d.empty, system: ['admin', 'local', 'config'].includes(d.name) }));
    },
    async collections(b) {
      const db = dbOf(b);
      const list = await db.listCollections({}, { nameOnly: false }).toArray();
      const counts = await Promise.all(list.map((c) => (c.type === 'collection' ? db.collection(c.name).estimatedDocumentCount().catch(() => null) : null)));
      return list.map((c, i) => ({ name: c.name, type: c.type, count: counts[i], options: out(c.options ?? {}) })).sort((a, b) => a.name.localeCompare(b.name));
    },
    async find(b) {
      const filter = inp(b.filter) ?? {};
      const limit = Math.min(Number(b.limit) || 50, MAX);
      const cur = coll(b).find(filter, { projection: inp(b.projection) || undefined, sort: inp(b.sort) || undefined, skip: Number(b.skip) || 0, limit });
      const [docs, total] = await Promise.all([cur.toArray(), b.count === false ? null : coll(b).countDocuments(filter, { maxTimeMS: 5000 }).catch(() => null)]);
      return { docs: docs.map(out), total };
    },
    async aggregate(b) {
      const pipeline = inp(b.pipeline) ?? [];
      const docs = await coll(b).aggregate([...pipeline, { $limit: Math.min(Number(b.limit) || MAX, MAX) }], { maxTimeMS: 30000 }).toArray();
      return { docs: docs.map(out) };
    },
    async insert(b) {
      const docs = (b.docs ?? []).map(inp);
      if (!docs.length) return { inserted: 0 };
      const r = await coll(b).insertMany(docs, { ordered: b.ordered !== false });
      return { inserted: r.insertedCount, ids: Object.values(r.insertedIds).map(out) };
    },
    async replace(b) {
      const doc = inp(b.doc);
      const id = inp(b.id);
      if (doc._id === undefined) doc._id = id;
      const r = await coll(b).replaceOne({ _id: id }, doc);
      return { matched: r.matchedCount, modified: r.modifiedCount };
    },
    async update(b) {
      const fn = b.many ? 'updateMany' : 'updateOne';
      const r = await coll(b)[fn](inp(b.filter) ?? {}, inp(b.update), { upsert: !!b.upsert });
      return { matched: r.matchedCount, modified: r.modifiedCount, upserted: r.upsertedCount };
    },
    async delete(b) {
      if (b.ids) { const r = await coll(b).deleteMany({ _id: { $in: b.ids.map(inp) } }); return { deleted: r.deletedCount }; }
      const filter = inp(b.filter);
      if (!filter || !Object.keys(filter).length) { if (!b.all) throw Object.assign(new Error('조건 없이 모두 지우려면 all: true 가 필요합니다'), { status: 400 }); }
      const r = await coll(b).deleteMany(filter ?? {});
      return { deleted: r.deletedCount };
    },
    async indexes(b) { return (await coll(b).listIndexes().toArray()).map(out); },
    async createIndex(b) { return { name: await coll(b).createIndex(inp(b.keys), inp(b.options) ?? {}) }; },
    async dropIndex(b) { await coll(b).dropIndex(b.name); return { ok: true }; },
    async createCollection(b) { await dbOf(b).createCollection(b.name, inp(b.options) ?? {}); return { ok: true }; },
    async dropCollection(b) { return { ok: await coll(b).drop() }; },
    async renameCollection(b) { await coll(b).rename(b.to); return { ok: true }; },
    async command(b) { return out(await dbOf(b).command(inp(b.command))); },
    async stats(b) {
      const admin = client.db('admin');
      const [srv, dbs] = await Promise.all([
        admin.command({ serverStatus: 1 }).catch(() => null),
        dbOf(b).command({ dbStats: 1 }).catch(() => null)
      ]);
      const info = srv ? { version: srv.version, uptime: srv.uptime, connections: srv.connections, opcounters: srv.opcounters, mem: srv.mem } : (await admin.command({ buildInfo: 1 }).then((x) => ({ version: x.version })).catch(() => ({})));
      return out({ ...info, db: dbs });
    }
  };
  return { dialect: 'mongodb', ops, close: () => client.close() };
}
