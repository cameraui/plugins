interface SnapshotCamera {
  streamSource: {
    getStreamStatus(): Promise<string>;
    snapshot(forceNew?: boolean): Promise<ArrayBuffer | undefined>;
  };
}

/** Cache thumbnails without waking an idle battery camera just for a preview. */
export class BatterySnapshotCache {
  private entries = new WeakMap<SnapshotCamera, { image?: Buffer; fetchedAt: number; pending?: Promise<Buffer | undefined> }>();

  public async get(camera: SnapshotCamera): Promise<Buffer | undefined> {
    let entry = this.entries.get(camera);
    if (!entry) {
      entry = { fetchedAt: -Infinity };
      this.entries.set(camera, entry);
    }
    if (entry.pending) return entry.pending;
    if (Date.now() - entry.fetchedAt < 60_000) return entry.image;
    entry.fetchedAt = Date.now();
    entry.pending = (async () => {
      try {
        if ((await camera.streamSource.getStreamStatus()) !== 'connected') return entry.image;
        const data = await camera.streamSource.snapshot(false);
        if (data?.byteLength) entry.image = Buffer.from(data);
      } catch {
        // Retain the last valid thumbnail on a temporary failure.
      }
      return entry.image;
    })();
    try {
      return await entry.pending;
    } finally {
      entry.pending = undefined;
    }
  }
}
