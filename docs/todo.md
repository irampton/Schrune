# Todo List

## High



## Not High, but Need to Do

* Test point class
* Figure out better imports, so 1 script can install missing dependencies
  * Shared modules (or even parts!) across files
* Mark as a do not place
* Better error logging by making a bunch of tests to test bad syntax and adding try/catch blocks

## Medium

* Add in generic KiCad footprints
* Default order for basic parts () declaration
* Get .step files like atopile
* Default to .h for rails when connecting to pins? (fix rail syntax)
* Some way to back-port the designators
* On part add, log out #include statement
* Error logging back to schrune file lines
* Module net group and rail pass through
* Add an export function
* JLC BOM tool

## Low

* Net group names
* Fix CLI to make it better
* Enforce `part` prefix?
* No insertion on basic functions into top file (--keep-js)
* Much better schematic layout
  * Better symbols for common components (zigzag resistors)
* VSCode Extension
  * Hover over info for parts and modules
  * Colors for nets, parts, and modules
  * More intentional colors
  * Disable suggestions in comments
* Add a "bridging" designator to parts with many pins

