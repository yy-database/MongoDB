// `PYO3_BUILD_EXTENSION_MODULE` stops pyo3 from linking libpython, so macOS
// needs `-undefined dynamic_lookup`. The cdylib arg only covers the dylib, so
// the generic link arg also lets cargo build the (empty) test harness.
fn main() {
    pyo3_build_config::add_extension_module_link_args();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-undefined");
        println!("cargo:rustc-link-arg=dynamic_lookup");
    }
}
