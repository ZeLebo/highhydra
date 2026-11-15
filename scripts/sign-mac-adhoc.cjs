const signMac = require("./legendary-mac-sign.cjs");

// Local ad hoc builds have no Team ID for hardened runtime library validation.
module.exports = (options, packager) =>
  signMac(
    {
      ...options,
      identity: "-",
      optionsForFile(filePath) {
        return {
          ...options.optionsForFile(filePath),
          hardenedRuntime: false,
        };
      },
    },
    packager
  );
