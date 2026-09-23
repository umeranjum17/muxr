//! A test target for the X11 backend, on a display this process owns.
//!
//! It draws one unmistakable pattern, records every pointer and key event it
//! receives as a JSON line, and paints a marker where it was last clicked. That
//! combination is what makes an end-to-end check honest: the viewer has to be
//! rendering the real pixels of a real X client, and the events that client
//! reports have to be the ones the user produced on the phone.
//!
//! Run it against a server you own:
//!
//! ```sh
//! Xvfb :99 -screen 0 1280x720x24 &
//! DISPLAY=:99 cargo run --example x11_target
//! ```

use anyhow::{Context, Result};
use std::io::Write;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    ConnectionExt as _, CreateGCAux, CreateWindowAux, EventMask, Rectangle, WindowClass,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

const WIDTH: u16 = 1280;
const HEIGHT: u16 = 720;

fn main() -> Result<()> {
    let (connection, screen_number) =
        RustConnection::connect(None).context("cannot open the X display in DISPLAY")?;
    let screen = &connection.setup().roots[screen_number as usize];
    let window = connection.generate_id()?;
    connection
        .create_window(
            x11rb::COPY_DEPTH_FROM_PARENT,
            window,
            screen.root,
            0,
            0,
            WIDTH,
            HEIGHT,
            0,
            WindowClass::INPUT_OUTPUT,
            x11rb::COPY_FROM_PARENT,
            &CreateWindowAux::new()
                .background_pixel(screen.white_pixel)
                .event_mask(
                    EventMask::EXPOSURE
                        | EventMask::BUTTON_PRESS
                        | EventMask::BUTTON_RELEASE
                        | EventMask::POINTER_MOTION
                        | EventMask::KEY_PRESS
                        | EventMask::KEY_RELEASE,
                ),
        )
        .context("cannot create the test window")?;
    connection.map_window(window)?;

    let graphics = connection.generate_id()?;
    connection.create_gc(graphics, window, &CreateGCAux::new())?;

    // A pattern that cannot be confused with a desktop: four coloured bands, a
    // grid, and the coordinates written into the top-left corner as a ladder of
    // ticks every 100 pixels so a capture can be read without any font.
    let mut marker = None;
    paint(&connection, window, graphics, marker)?;
    connection.flush()?;

    // Put the pointer inside the window so key events have an obvious target on
    // a server with no window manager.
    connection.warp_pointer(
        x11rb::NONE,
        window,
        8,
        8,
        0,
        0,
        (WIDTH / 2) as i16,
        (HEIGHT / 2) as i16,
    )?;
    connection.flush()?;

    let mut out = std::io::stdout();
    emit(
        &mut out,
        "ready",
        &[("width", WIDTH.to_string()), ("height", HEIGHT.to_string())],
    );

    loop {
        let event = connection
            .wait_for_event()
            .context("the X connection dropped")?;
        match event {
            Event::Expose(_) => {
                paint(&connection, window, graphics, marker)?;
                connection.flush()?;
            }
            Event::MotionNotify(motion) => {
                emit(
                    &mut out,
                    "pointer",
                    &[
                        ("x", motion.event_x.to_string()),
                        ("y", motion.event_y.to_string()),
                    ],
                );
            }
            Event::ButtonPress(press) => {
                emit(
                    &mut out,
                    "button",
                    &[
                        ("x", press.event_x.to_string()),
                        ("y", press.event_y.to_string()),
                        ("button", press.detail.to_string()),
                        ("phase", String::from("down")),
                    ],
                );
            }
            Event::ButtonRelease(release) => {
                // A press and release at the same place is what the phone sends
                // for a tap; recording the marker there makes the click visible in
                // the captured picture as well as in this log.
                if release.detail == 1 {
                    marker = Some((release.event_x, release.event_y));
                    paint(&connection, window, graphics, marker)?;
                }
                emit(
                    &mut out,
                    "button",
                    &[
                        ("x", release.event_x.to_string()),
                        ("y", release.event_y.to_string()),
                        ("button", release.detail.to_string()),
                        ("phase", String::from("up")),
                    ],
                );
                connection.flush()?;
            }
            Event::KeyPress(press) => {
                emit(
                    &mut out,
                    "key",
                    &[
                        ("keycode", press.detail.to_string()),
                        ("phase", String::from("down")),
                    ],
                );
                if press.detail == 9 {
                    // Escape: the lab's own stop key.
                    emit(&mut out, "quit", &[]);
                    connection.destroy_window(window)?;
                    connection.flush()?;
                    return Ok(());
                }
            }
            Event::KeyRelease(release) => {
                emit(
                    &mut out,
                    "key",
                    &[
                        ("keycode", release.detail.to_string()),
                        ("phase", String::from("up")),
                    ],
                );
            }
            _ => {}
        }
    }
}

fn paint(
    connection: &RustConnection,
    window: u32,
    graphics: u32,
    marker: Option<(i16, i16)>,
) -> Result<()> {
    let bands: [(u32, u16, u16); 4] = [
        (0x00d04040, 0, HEIGHT / 4),
        (0x0040d040, HEIGHT / 4, HEIGHT / 2),
        (0x004040d0, HEIGHT / 2, HEIGHT * 3 / 4),
        (0x00d0d040, HEIGHT * 3 / 4, HEIGHT),
    ];
    for (colour, y, height) in bands {
        connection.change_gc(
            graphics,
            &x11rb::protocol::xproto::ChangeGCAux::new().foreground(colour),
        )?;
        connection.poly_fill_rectangle(
            window,
            graphics,
            &[Rectangle {
                x: 0,
                y: y as i16,
                width: WIDTH,
                height: (height - y) as u16,
            }],
        )?;
    }
    connection.change_gc(
        graphics,
        &x11rb::protocol::xproto::ChangeGCAux::new().foreground(0x00ffffff),
    )?;
    let mut ticks = Vec::new();
    for step in 0..(WIDTH / 100) {
        let x = step * 100;
        ticks.push(Rectangle {
            x: x as i16,
            y: 0,
            width: 2,
            height: if step % 5 == 0 { 40 } else { 16 },
        });
    }
    for step in 0..(HEIGHT / 100) {
        let y = step * 100;
        ticks.push(Rectangle {
            x: 0,
            y: y as i16,
            width: if step % 5 == 0 { 40 } else { 16 },
            height: 2,
        });
    }
    connection.poly_fill_rectangle(window, graphics, &ticks)?;
    if let Some((x, y)) = marker {
        connection.change_gc(
            graphics,
            &x11rb::protocol::xproto::ChangeGCAux::new().foreground(0x00000000),
        )?;
        connection.poly_fill_rectangle(
            window,
            graphics,
            &[Rectangle {
                x: x.saturating_sub(6),
                y: y.saturating_sub(6),
                width: 12,
                height: 12,
            }],
        )?;
        connection.change_gc(
            graphics,
            &x11rb::protocol::xproto::ChangeGCAux::new().foreground(0x00ffffff),
        )?;
        connection.poly_fill_rectangle(
            window,
            graphics,
            &[Rectangle {
                x: x.saturating_sub(2),
                y: y.saturating_sub(2),
                width: 4,
                height: 4,
            }],
        )?;
    }
    Ok(())
}

fn emit(out: &mut impl Write, kind: &str, fields: &[(&str, String)]) {
    let mut line = format!("{{\"kind\":\"{kind}\"");
    for (name, value) in fields {
        if value.chars().all(|c| c.is_ascii_digit()) {
            line.push_str(&format!(",\"{name}\":{value}"));
        } else {
            line.push_str(&format!(",\"{name}\":\"{value}\""));
        }
    }
    line.push('}');
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}
