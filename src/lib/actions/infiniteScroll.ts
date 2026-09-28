/** Calls `onIntersect` once the element scrolls into view, e.g. to load the next page. */
export function infiniteScroll(node: HTMLElement, onIntersect: () => void): { destroy(): void } {
	const observer = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (entry.isIntersecting) {
				onIntersect();
			}
		}
	});

	observer.observe(node);

	return {
		destroy() {
			observer.disconnect();
		}
	};
}
