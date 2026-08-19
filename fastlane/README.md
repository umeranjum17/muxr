fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## iOS

### ios distribute_internal

```sh
[bundle exec] fastlane ios distribute_internal
```

Wait for an uploaded build and assign it to internal TestFlight testers

### ios promote_production

```sh
[bundle exec] fastlane ios promote_production
```

Submit an existing TestFlight build for App Review

----


## Android

### android verify_internal

```sh
[bundle exec] fastlane android verify_internal
```

Prove the submitted build is completed on Play Internal

### android promote_production

```sh
[bundle exec] fastlane android promote_production
```

Promote an existing Play Internal build to Production

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
