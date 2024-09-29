declare module '*.svg' {
	const content: string;
	export default content;
}

/** Specified keys become partial, others persist as original. */
type PartialKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>
