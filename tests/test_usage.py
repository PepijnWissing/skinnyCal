"""Selenium tests driving usage.py against a real browser.

Requires ``dash[dev,testing]`` (tests/requirements.txt) and a Chrome/chromedriver
available on PATH. Run with ``pytest -q``.
"""
from dash.testing.application_runners import import_app
from selenium.webdriver.support.ui import WebDriverWait


def test_setprops_updates_event_in_place_without_remount(dash_duo):
    """command {'type': 'setProps'} must mutate an existing event's title and
    extendedProps on its existing DOM block (no remount) and refresh the
    eventDataAttributes ``data-*`` mirror to match the new extendedProps.
    """
    app = import_app("usage")
    dash_duo.start_server(app)

    audit = '[data-event-id="audit"]'
    dash_duo.wait_for_element(audit, timeout=10)

    # Initial state: build_events("audit") + eventDataAttributes=["trainer"].
    assert dash_duo.find_element(audit).get_attribute("data-trainer") == "AB"
    assert "Audit" in dash_duo.find_element(audit).text

    # Stamp a marker on the LIVE element. Replacing the `events` prop would
    # destroy this element and recreate it (dropping the marker); an in-place
    # `setProps` mutation reuses the same node, so the marker must survive.
    dash_duo.driver.execute_script(
        "document.querySelector(arguments[0])"
        ".setAttribute('data-remount-probe', 'kept')",
        audit,
    )

    dash_duo.find_element("#setprops").click()

    # Title text refreshes in place...
    WebDriverWait(dash_duo.driver, 10).until(
        lambda _d: "Audit (renamed" in dash_duo.find_element(audit).text
    )
    # ...and so does the mirrored data-* (trainer AB -> ZZ)...
    WebDriverWait(dash_duo.driver, 10).until(
        lambda _d: dash_duo.find_element(audit).get_attribute("data-trainer")
        == "ZZ"
    )
    # ...on the very same element (marker survived => no remount).
    assert (
        dash_duo.find_element(audit).get_attribute("data-remount-probe")
        == "kept"
    )
