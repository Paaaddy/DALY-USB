# Changelog

## [0.1.0](https://github.com/LeoTronick/DALY-USB/compare/v0.0.1...v0.1.0) (2026-05-11)


### Features

* auto-discover cell and temp sensor counts via 0x94 ([4ad38e5](https://github.com/LeoTronick/DALY-USB/commit/4ad38e5b7eaf18e2c63acf47140cee5a9a1a1d19))
* full read coverage of commands 0x90-0x98 ([8e97891](https://github.com/LeoTronick/DALY-USB/commit/8e97891c2a0c9326dd0aa8c99029f358357ba1d4))
* poll 0x90 pack measurements over serialised serial transport ([b2c63a6](https://github.com/LeoTronick/DALY-USB/commit/b2c63a6a373af58bd8e84bc889f2fd9a71013be9))
* safety hardening for writes, bounds, and unload race ([eef8243](https://github.com/LeoTronick/DALY-USB/commit/eef8243397ce5ff482b565223e45173616bfc011))
* writable charge and discharge MOSFET controls ([578533b](https://github.com/LeoTronick/DALY-USB/commit/578533b7a6490ab1f8b2d6def0b03726cff63337))


### Performance Improvements

* cache request buffers and throttle failure logs ([728e828](https://github.com/LeoTronick/DALY-USB/commit/728e828563303d0822e9f4ddb6d367b75d56acb0))
