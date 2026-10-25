/** 端口实现共用的简单订阅集合：多订阅者、退订安全、emit 期间退订不影响本轮遍历 */

export interface Emitter<E> {
  emit(event: E): void;
  subscribe(handler: (event: E) => void): () => void;
}

export function createEmitter<E>(): Emitter<E> {
  const handlers = new Set<(event: E) => void>();
  return {
    emit(event: E): void {
      for (const handler of [...handlers]) handler(event);
    },
    subscribe(handler: (event: E) => void): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
