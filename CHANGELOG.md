# Changelog

## [0.2.2](https://github.com/LeoTronick/DALY-USB/compare/v0.2.1...v0.2.2) (2026-05-14)


### Bug Fixes

* remove prepare script so git installs use committed build output ([8acc148](https://github.com/LeoTronick/DALY-USB/commit/8acc1489a351d395af3a969aade44ab7995641c3))
* remove prepare script so git installs use committed build output ([48ce5b0](https://github.com/LeoTronick/DALY-USB/commit/48ce5b077f15cb3e4bb65be9d4015e7fd8855bee))

## [0.2.1](https://github.com/LeoTronick/DALY-USB/compare/v0.2.0...v0.2.1) (2026-05-14)


### Bug Fixes

* commit build output so git installs work on npm 10 ([d9e43eb](https://github.com/LeoTronick/DALY-USB/commit/d9e43eb706201e7e3cc2532fc8287b945c9381a3))
* commit build output so git installs work on npm 10 ([f3c1804](https://github.com/LeoTronick/DALY-USB/commit/f3c1804500f18e6363af2c6bb5d54838ed9b29a1))

## [0.2.0](https://github.com/LeoTronick/DALY-USB/compare/v0.1.0...v0.2.0) (2026-05-12)


### Features

* hardware safety hardening ([29529bf](https://github.com/LeoTronick/DALY-USB/commit/29529bf4b31744dfcd93aa78f31ba3460f32cf29))
* hardware safety hardening from autoplan security review ([c4b95e1](https://github.com/LeoTronick/DALY-USB/commit/c4b95e161d242eddf9de8dc5757cf5a0f8fd43c3))


### Bug Fixes

* add prepare script so git installs compile TypeScript ([d010719](https://github.com/LeoTronick/DALY-USB/commit/d010719ae14935cb866a5494ceba8e52c18fe9f6))
* add prepare script so git installs compile TypeScript ([88b1f1e](https://github.com/LeoTronick/DALY-USB/commit/88b1f1e4ccb91a458fd94e002840787d66916a25))
* derive pack voltage ceiling from discovered cell count ([5f09040](https://github.com/LeoTronick/DALY-USB/commit/5f0904007a2c298b43120e8bdc7d024afa5a828b))

## [0.1.0](https://github.com/LeoTronick/DALY-USB/compare/v0.0.1...v0.1.0) (2026-05-11)


### Features

* auto-discover cell and temp sensor counts via 0x94 ([4ad38e5](https://github.com/LeoTronick/DALY-USB/commit/4ad38e5b7eaf18e2c63acf47140cee5a9a1a1d19))
* full read coverage of commands 0x90-0x98 ([8e97891](https://github.com/LeoTronick/DALY-USB/commit/8e97891c2a0c9326dd0aa8c99029f358357ba1d4))
* poll 0x90 pack measurements over serialised serial transport ([b2c63a6](https://github.com/LeoTronick/DALY-USB/commit/b2c63a6a373af58bd8e84bc889f2fd9a71013be9))
* safety hardening for writes, bounds, and unload race ([eef8243](https://github.com/LeoTronick/DALY-USB/commit/eef8243397ce5ff482b565223e45173616bfc011))
* writable charge and discharge MOSFET controls ([578533b](https://github.com/LeoTronick/DALY-USB/commit/578533b7a6490ab1f8b2d6def0b03726cff63337))


### Performance Improvements

* cache request buffers and throttle failure logs ([728e828](https://github.com/LeoTronick/DALY-USB/commit/728e828563303d0822e9f4ddb6d367b75d56acb0))
