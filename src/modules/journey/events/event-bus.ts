type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  on<T>(event: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    const set = this.handlers.get(event)!;
    set.add(handler as EventHandler);
    return () => set.delete(handler as EventHandler);
  }

  async emit<T>(event: string, payload: T): Promise<void> {
    const set = this.handlers.get(event);
    if (!set?.size) return;
    await Promise.all([...set].map((handler) => Promise.resolve(handler(payload))));
  }
}

export const eventBus = new EventBus();
