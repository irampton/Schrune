# Todo List

## High
* Test point class
  * Parts with a single pin can just connect to a net?
  * Variable size
* Figure out better imports:
  * Shared modules with their own parts
  * Common parts folder?
* Much better schematic layout
  * Better symbols for common components (zigzag resistors)

## Medium

* Default order for basic parts () declaration
* Code cleanup
  * Add a ton of tests to validate builds
  * Go through an streamline code + break up large files

## Low

* VSCode Extension
  * Hover over info for parts and modules
  * Colors for nets, parts, and modules
  * More intentional colors
  * Disable suggestions in comments
* Add a "bridging" designator to parts with many pins
* No insertion on basic functions into top file (--keep-js)
* Some way to back-port (or set) the designators to the .schrune files

## Maybe

* Enforce `part` prefix?
* Add in generic KiCad footprints?
* Add an export build files function?

