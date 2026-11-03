## [2.0.6](https://github.com/dee-wan-cms/cache/compare/v2.0.5...v2.0.6) (2026-11-03)


### Bug Fixes

* share cold fills with active warmup ([e080368](https://github.com/dee-wan-cms/cache/commit/e080368e014ff4e843bf4fa3c53472a007a18c9a))

## [2.0.5](https://github.com/dee-wan-cms/cache/compare/v2.0.4...v2.0.5) (2026-11-03)


### Bug Fixes

* coalesce cold fills and warm scoped bootstrap ([4917aec](https://github.com/dee-wan-cms/cache/commit/4917aec547b46f5a7a6b07e871b624119a5a728d))

## [2.0.4](https://github.com/dee-wan-cms/cache/compare/v2.0.3...v2.0.4) (2026-11-03)


### Bug Fixes

* **cache:** bound warmup retries and read TTLs ([95b53f1](https://github.com/dee-wan-cms/cache/commit/95b53f185d8dfbcb0cffb4652e80ac9127672fb9))

## [2.0.3](https://github.com/dee-wan-cms/cache/compare/v2.0.2...v2.0.3) (2026-11-03)


### Bug Fixes

* **warmup:** support full media batch URLs ([7b68406](https://github.com/dee-wan-cms/cache/commit/7b68406b67966fa00a43a6d9b8965a75abb09834))

## [2.0.2](https://github.com/dee-wan-cms/cache/compare/v2.0.1...v2.0.2) (2026-11-03)


### Bug Fixes

* **warmup:** prioritize newly discovered batches ([7b099aa](https://github.com/dee-wan-cms/cache/commit/7b099aa3f0ffe30fffb1099d37994b359b798b33))

## [2.0.1](https://github.com/dee-wan-cms/cache/compare/v2.0.0...v2.0.1) (2026-11-03)


### Bug Fixes

* retain warm sources and D1 ownership ([79cc795](https://github.com/dee-wan-cms/cache/commit/79cc795979f758ee9db85b820074d00ef0d07840))

# [2.0.0](https://github.com/dee-wan-cms/cache/compare/v1.1.0...v2.0.0) (2026-11-02)


* feat(d1)!: preserve replica read consistency ([5dd7276](https://github.com/dee-wan-cms/cache/commit/5dd727669607734ae0a3e67866af457adbb3e46c))


### BREAKING CHANGES

* Workers importing @dee-wan/cache/d1 must enable
nodejs_compat. CMS and generated Workers already enable this flag.

# [1.1.0](https://github.com/dee-wan-cms/cache/compare/v1.0.1...v1.1.0) (2026-11-02)


### Bug Fixes

* **build:** retain Worker builtin protocol ([2e54445](https://github.com/dee-wan-cms/cache/commit/2e544452078c25529530f9bcc5b7065c6fde8171))
* cache aggregate and grouped reads ([3cfaeb4](https://github.com/dee-wan-cms/cache/commit/3cfaeb4ed550f4af1b99a06dc0ef93cfaeb7d5dd))
* **cache:** accept JSON freshness policies ([7bdc9dd](https://github.com/dee-wan-cms/cache/commit/7bdc9ddb579ab6418158f47ce8a4daf638513c66))
* **cache:** fill streaming responses in background ([806e7e2](https://github.com/dee-wan-cms/cache/commit/806e7e21927368ad859cbb514f31fc27770089e3))
* **cache:** hash regional Prisma config keys ([d86d6c7](https://github.com/dee-wan-cms/cache/commit/d86d6c72eb871fb2632c911a9ddcfc64191d4463))
* **cache:** keep writer reads fast and fresh ([b79f9d4](https://github.com/dee-wan-cms/cache/commit/b79f9d42e1946af47d2bccfa254f0a289277bf49))
* **cache:** request plain JSON from origin ([4e51846](https://github.com/dee-wan-cms/cache/commit/4e51846d3c03087a886309fe3a259b90cd8a7565))
* **cache:** retain large CMS read responses ([7331729](https://github.com/dee-wan-cms/cache/commit/73317294212e120c889dfe946c66ec48e2e41797))
* **cache:** reuse conditional read leases ([fc6ee35](https://github.com/dee-wan-cms/cache/commit/fc6ee35530eea8cbf2dce5653b94310c390241ff))
* **cache:** separate browser and fresh read control ([2634175](https://github.com/dee-wan-cms/cache/commit/2634175430ed4f4e6c8915703aac73ca343ed616))
* **cache:** share mutation freshness policy ([37fcca4](https://github.com/dee-wan-cms/cache/commit/37fcca4a2c004cd736eeec3be8eb9e94569d170c))
* **ci:** use the built-in release token ([c544197](https://github.com/dee-wan-cms/cache/commit/c54419714c8e267ef1777aba50a7535f7ffcd3b4))
* **client:** coalesce automatic revalidation ([ed59efe](https://github.com/dee-wan-cms/cache/commit/ed59efe1e63291e8fbc8dc6800cfce0a092d0fb9))
* **client:** honor initial revalidation window ([afbce9f](https://github.com/dee-wan-cms/cache/commit/afbce9fbcd1b5141cc8028ff45c0eaf7b2cc600e))
* **d1:** refill leases after fresh reads ([171eed7](https://github.com/dee-wan-cms/cache/commit/171eed769c6536bd17c14ee744d64d28158b075e))
* **d1:** refresh metadata before filling leases ([cc057a1](https://github.com/dee-wan-cms/cache/commit/cc057a1f3f21d765b6a33bcc2d8168d9baad8b4c))
* **d1:** retry completed write cleanup ([7641862](https://github.com/dee-wan-cms/cache/commit/76418620d6d44634c7167f58d3004781f6fa35e5))
* **d1:** select declared cookie identities ([02ae7a7](https://github.com/dee-wan-cms/cache/commit/02ae7a7d38562c35274491eb812a2fc62ef077c7))
* support stable read-key arguments ([f698a00](https://github.com/dee-wan-cms/cache/commit/f698a006394a815e2311022dac17213342c4ddd8))


### Features

* **cache:** add bounded regional reads ([64ce065](https://github.com/dee-wan-cms/cache/commit/64ce0656133ebfdf50c16ea640a0bf20ce49288d))
* **cache:** add support for excluding freshness cookie on specified paths ([7288626](https://github.com/dee-wan-cms/cache/commit/72886261872a8dda9664b0125ac63a0db8320753))
* **cache:** allow five-minute CMS read leases ([0389c60](https://github.com/dee-wan-cms/cache/commit/0389c60004f6428a060c23d2552994dd60fc3a96))
* **cache:** expose standalone Worker caching ([ae798bf](https://github.com/dee-wan-cms/cache/commit/ae798bf15b108eb660e51774aa0ec952cb832652))
* **cache:** share scoped mutation invalidations ([c46c139](https://github.com/dee-wan-cms/cache/commit/c46c139393ac61b15ad81af38e786dea8ac5a0b8))
* **cache:** warm reads on navigation intent ([d4057ea](https://github.com/dee-wan-cms/cache/commit/d4057ea91c5b1cf682e7632cd8fea9d53f5dd1d4))
* **cache:** warm scoped edge responses ([c81269d](https://github.com/dee-wan-cms/cache/commit/c81269d13ec372fba6700c3f3253d5e39f77b3ec))
* **client:** coalesce pending reads ([35e75da](https://github.com/dee-wan-cms/cache/commit/35e75dae0af74970797d332458184da49944cf41))
* **d1:** coordinate scoped CMS cache reads ([68ca8db](https://github.com/dee-wan-cms/cache/commit/68ca8db984b84e9ccb4763ed48114a03b3e89ef6))
* **d1:** expose coordinated cache epochs ([0c7872a](https://github.com/dee-wan-cms/cache/commit/0c7872a87c4329b2ede4da7cf201dc2bb32910bb))


### Performance Improvements

* **cache:** avoid serializing cached bodies twice ([39fdbcc](https://github.com/dee-wan-cms/cache/commit/39fdbccb71a82cef4eda5958e7da3f90c07fba6b))
* **cache:** bridge edge leases to placed origin ([c1e3f27](https://github.com/dee-wan-cms/cache/commit/c1e3f2750783d3b449730f8aad6262a35753e326))
* **cache:** lease verified reads at the edge ([3af12be](https://github.com/dee-wan-cms/cache/commit/3af12be79be83142efb442fa375c0efb236fc350))
* **cache:** refresh valid leases ahead of expiry ([723a18b](https://github.com/dee-wan-cms/cache/commit/723a18b8029b5a79443cff699a35054a68934d35))
* **d1:** stream cached HTTP response bodies ([0d24c0f](https://github.com/dee-wan-cms/cache/commit/0d24c0f6420a06a9df99cdb0e1466dfa08cde0b9))

## [1.0.1](https://github.com/dee-wan-cms/cache/compare/v1.0.0...v1.0.1) (2026-09-20)


### Bug Fixes

* normalize generator binary path ([0e5a38b](https://github.com/dee-wan-cms/cache/commit/0e5a38be5015fded5a49f95a0650d00205416d1e))

# 1.0.0 (2026-09-20)


### Features

* add worker setup and schema for cache testing ([586ef94](https://github.com/dee-wan-cms/cache/commit/586ef940886dca00a3f9f2cd7b93db8fa64a1ac2))
