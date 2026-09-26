#include <inputtino/keyboard.hpp>

// XKB plans physical evdev keys; inputtino's public API takes Moonlight/Windows
// virtual-key identities. Use its complete mapping rather than duplicating a
// US character table (which would break other layouts and named keys).
extern "C" short dl_inputtino_keycode(short evdev_code) {
  for (const auto &[virtual_key, mapping] : inputtino::keyboard::key_mappings) {
    if (mapping.linux_code == evdev_code) return virtual_key;
  }
  return -1;
}
