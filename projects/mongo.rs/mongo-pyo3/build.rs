// `PYO3_BUILD_EXTENSION_MODULE` stops pyo3 from linking libpython, so macOS
// needs `-undefined dynamic_lookup` on the cdylib. maturin adds it for wheel
// builds; this build script covers the plain `cargo test` path in CI.
fn main() {
    pyo3_build_config::add_extension_module_link_args();
}
