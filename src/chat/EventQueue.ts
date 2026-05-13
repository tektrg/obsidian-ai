/**
 * EventQueue - Async generator-based event streaming
 * 
 * Provides a unified interface for streaming events from any backend.
 * Used by both Claude SDK and Pi SDK bridges.
 */

export class EventQueue<T> {
	private queue: T[] = [];
	private resolvers: Array<() => void> = [];
	private completed = false;
	private error: Error | null = null;

	/**
	 * Add an event to the queue
	 */
	enqueue(event: T): void {
		this.queue.push(event);
		this.flush();
	}

	/**
	 * Mark the queue as complete (no more events)
	 */
	complete(): void {
		this.completed = true;
		this.flush();
	}

	/**
	 * Set an error and complete the queue
	 */
	setError(err: Error): void {
		this.error = err;
		this.completed = true;
		this.flush();
	}

	/**
	 * Async generator that yields events until complete
	 */
	async *events(): AsyncGenerator<T> {
		while (!this.completed || this.queue.length > 0) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.error) {
				throw this.error;
			} else if (this.completed) {
				return;
			} else {
				await this.waitForNext();
			}
		}
	}

	/**
	 * Check if the queue is empty and completed
	 */
	isDone(): boolean {
		return this.completed && this.queue.length === 0;
	}

	/**
	 * Get current queue size (for debugging)
	 */
	get size(): number {
		return this.queue.length;
	}

	/**
	 * Reset the queue to initial state
	 */
	reset(): void {
		this.queue = [];
		this.resolvers = [];
		this.completed = false;
		this.error = null;
	}

	private waitForNext(): Promise<void> {
		return new Promise(resolve => this.resolvers.push(resolve));
	}

	private flush(): void {
		while (this.resolvers.length > 0) {
			this.resolvers.shift()!();
		}
	}
}
