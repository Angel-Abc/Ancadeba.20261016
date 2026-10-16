export interface Resolver<S> {
  resolve<K extends keyof S>(key: K): S[K]
}

export type Factories<Services, Dependencies = Services> = {
  [K in keyof Services]: (resolver: Resolver<Dependencies>) => Services[K]
}
