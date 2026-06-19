# compilerSteps.md

This file descibes the steps of the Schrune Compiler. The goal is to translate a .schrune file into a KiCad Schmatic.

## CLI Commands

The compiler entry point is `app.js`.

```
node app.js build [--keep-js] path/to/file.schrune
node app.js add C2040
```

`build` runs the current compiler flow. `--keep-js` keeps the Step 1 JavaScript
files next to the source `.schrune` files.

`add` imports an LCSC part into `./parts/<PartName>/`. It downloads the EasyEDA
component data, writes KiCad symbol and footprint files (`.kicad_sym` and
`.kicad_mod`), attempts to download the 3D model as a `.step` through EasyEDA's
model UUID endpoint, and writes a `<PartName>.schrune` file with component
metadata and pin mappings. If the STEP payload is empty, an EasyEDA error
document, or otherwise not directly available, the part is generated without a
model file.

## Step 1 - Compile to JS

In this step the compiler turns the .schrune file(s) into a vaild Node.JS file that outputs a list of componets and nets.

### Step 1a - Name the Nets

The first step is for the compiler to name all the nets. 
This is done first to avoid collisions, and is done as follows:

Starting with the top module, find every "net" designator and replace it with a variable setting the net to a string of it's name. If there is already a net with that name, append an _1 to it. 

``` 
net gpio;
// Becomes
const gpio = "gpio";
```
Then do the same for rails, `rail power;` becomes: 
```
const power = {
        "h": "power_h",
        "l": "power_l",
        voltage: undefined
    };
```

Unless a .name is applied to any net, then that name overrides the inital name. For each net and rail the compiler should check for any name changes. An error is thrown if any nets are overridden to be the same name. Two net must never have the same string.

```
rail power;

...
...
...

power.h.name = "POWER";
```

becomes

```
const power = {
        "h": "POWER",
        "l": "power_l",
        voltage: undefined
    };
```


> In the future, there will be other ways to create nets, but these are the only two for now.

> Also in the future we will suport submodules, but not now, so only the top modules nets are elaborated.

### Step 1b - Elaborate Parts

After the nets have stable names, the compiler elaborates the parts used by the
top module.

1. Resolve each `#include` statement to a Schrune part file.
2. Parse every included `part Name { ... }` declaration into a part template.
   For this first pass, a part template contains:
   - `info: { ... }`
   - `pins: [ name:pad, ... ]`
3. For every top-module statement like:

```
part header_1 = new BOOMELE_2_54_2_3P();
part[3] encoders = new BOURNS_PEC11R_4020F_S0024();
cap = new Capacitor(value = 100nF +/- 10%, footprint = "0402");
```

create a new component instance from the named part template. The instance gets
its own `pins` collection, and every pin starts with an empty `net` value.
Fixed-size component arrays create that many independent component instances.
For this first pass, arrays must contain only one component type.

For this first pass, the compiler also has built-in primitive components:
`Resistor`, `Capacitor`, `Diode`, and `Inductor`. Each primitive has exactly two
pins, `[0]` and `[1]`. Each primitive requires a `value` constructor parameter
and may include `footprint`.

4. For every connection statement like:

```
header_1[1] ~ v.h;
dc_input.VIN ~ v.h;
v.h ~ header_1[1];
```

classify both sides as either a component pin or a named net/rail side. If one
side is a component pin and the other side is a net, set the pin's `net` value
to the final net string. The order does not matter, so `header_1[1] ~ v.h;` and
`v.h ~ header_1[1];` produce the same result.

If both sides are component pins, create an implicit net after all explicit nets
are named:

```
header_3[1] ~ header_2[1];
```

The default implicit net name comes from the left side of the first pin-to-pin
connection seen for that net, so the example above becomes `header_3_1`.
Implicit nets may also be renamed with `.name` on a pin reference:

```
header_3[1].name = "shared_power";
header_3[1] ~ header_2[1];
```

As with explicit nets, duplicate final net names are errors.

5. For every bridge statement like:

```
threeV ~> shift_register_decoupling ~> gnd;
net1 ~> r1 ~> r2 ~> net2;
```

the middle terms must be components with exactly two pins. The compiler expands
the bridge into ordinary connections:

```
threeV ~ shift_register_decoupling[0];
shift_register_decoupling[1] ~ gnd;
net1 ~ r1[0];
r1[1] ~ r2[0];
r2[1] ~ net2;
```

Anything that can be used as a net endpoint may be used on the outside edges of
the bridge.

6. After declarations and component elaboration, execute simple JavaScript-style
loops and branches that contain Step 1 statements:

```
for (let i = 0; i < encoders.length; i++){
    encoders[i].A ~ shift_register.inputs[i * 3 + 0];
    if (i <= 2) {
        encoders[i].4 ~ shift_register.inputs[i * 3 + 2];
    } else {
        encoders[i].4 ~ cs;
    }
}
```

Loop bodies may use loop variables in array indexes and pin-group indexes. Part
files may define nested pin groups inside `pins`, such as
`inputs: [ 0:11, 1:12 ]`, which are referenced as
`shift_register.inputs[0]`.

At the end of Step 1, the compiled top module should return:

```
{
    netList,
    components,
    nets
}
```

`netList` is a `Set` of all final net strings. `components` is the ordered list
of component instances created in the top module. `nets` maps each top-module
net or rail variable name to its final compiled value.

This first pass does not generate a JS file on disk. It compiles the specified
`.schrune` file in memory and logs the return value of the `top()` module.


## Step 2 - Assign Designators

Take the output from Step 1 and assign a deterministic designator to each
component, such as `R1`, `C25`, or `J2`.

The designator prefix comes from `component.info.designatorPrefix`. Generic
components use their class defaults: `R`, `C`, `L`, and `D`.

Designators are assigned by stable component signatures rather than raw compile
order. A signature includes:

- component type
- value
- footprint/package
- voltage, power, and tolerance constraints when present
- connected net names

New designators use the lowest unused number for each prefix.

## Step 3 - Generate BOM

Fill out generic components, generate a BOM, and prepare to make a schematic.

Generic components are `Resistor`, `Capacitor`, `Inductor`, and `Diode`. They
must have `value`, may have `footprint`, and can also carry selector fields such
as `voltage`, `power`, and `tolerance`.

The compiler writes and reads:

```
parts/autogenerated/parts-lock.json
```

The lock has two readable sections:

```
{
    "version": 1,
    "parts": [
        {
            "lcsc": "C1234",
            "manufacturer": "YAGEO",
            "mpn": "RC0603FR-0710KL",
            "package": "0603"
        }
    ],
    "selectors": {
        "R1": "C1234"
    }
}
```

`parts` is the catalog of autogenerated LCSC/JLC parts under
`parts/autogenerated/`. `selectors` maps each generic component designator that
needs a selected part to the LCSC number it should use. Normal builds check this
file before making any JLC API call. `--no-parts-lock` ignores the lock for
selection and does not update it.

For unlocked generic parts, the selector searches JLC using value, footprint,
and type. Candidates are sorted to prefer:

1. in-stock parts
2. preferred/promoted parts
3. basic parts
4. higher stock
5. lower unit cost

Once a part is selected, the existing LCSC importer downloads its symbol,
footprint, and model into `parts/autogenerated/`.

At the end of Step 3, the compiler writes:

```
{filename}.BOM.csv
```

The CSV groups equivalent components and includes designators, quantity,
manufacturer, manufacturer part number, LCSC number, value, footprint, type,
description, stock, unit cost, and basic/preferred flags.

## Step 4 - Generate KiCad Schmatic

Take the module level output and turn that into a KiCad schmatic. This includes grabbing LSCS data, if needed.
