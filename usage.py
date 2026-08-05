from dash import Dash, html, Input, Output, State
import skinnycal as dcal

app = Dash(__name__)

# Per-event decoration seam (skinnycal >= 0.2.0):
#   * every block automatically gets data-event-id="<event id>"
#   * extendedProps.classNames become real classes on that block
#   * eventDataAttributes mirrors whitelisted extendedProps keys as data-*
#
# In-place event updates (skinnycal >= 0.3.0):
#   * command {'type': 'setProps', 'updates': [...]} changes an existing
#     event's title / extendedProps WITHOUT replacing the `events` prop, so the
#     block is NOT remounted, and any eventDataAttributes data-* mirrors refresh.
#     Contrast with the "Toggle conflict block" button below, which returns a
#     new events list and therefore remounts every block.
app.index_string = """<!DOCTYPE html>
<html>
    <head>
        {%metas%}<title>{%title%}</title>{%favicon%}{%css%}
        <style>
            .fc-event.is-conflict-hard {
                border-color: #c0392b !important;
                box-shadow: 0 0 0 2px rgba(192, 57, 43, 0.2);
            }
            .fc-event.is-conflict-soft {
                border-color: #b7791f !important;
                box-shadow: 0 0 0 2px rgba(183, 121, 31, 0.2);
            }
        </style>
    </head>
    <body>
        {%app_entry%}
        <footer>{%config%}{%scripts%}{%renderer%}</footer>
    </body>
</html>"""


def build_events(conflict_id):
    """Two events; `conflict_id` names the one carrying the hard-conflict class."""
    return [
        {
            "id": "audit",
            "title": "Audit",
            "date": "2025-08-01",
            "extendedProps": {
                "trainer": "AB",
                "classNames": ["is-conflict-hard"] if conflict_id == "audit" else [],
            },
        },
        {
            "id": "golive",
            "title": "Go‑Live",
            "date": "2025-08-10",
            "extendedProps": {
                "trainer": "CD",
                "classNames": ["is-conflict-hard"] if conflict_id == "golive" else [],
            },
        },
    ]


app.layout = html.Div(
    [
        html.Button("Toggle conflict block", id="toggle"),
        html.Button("Rename Audit in place (setProps)", id="setprops"),
        dcal.FullCalendar(
            id="cal",
            initialView="dayGridMonth",
            initialDate="2025-08-01",
            editable=True,
            selectable=True,
            # FullCalendar props passed unchanged:
            headerToolbar={"left": "prev,next today", "center": "title",
                           "right": "dayGridMonth,timeGridWeek"},
            events=build_events("audit"),
            eventDataAttributes=["trainer"],
        ),
        html.Div(id="clicked"),
    ],
    style={
            "paddingLeft": "20%",
            "paddingRight": "20%",
            "paddingBottom": "10%",
        }
)


@app.callback(Output("clicked", "children"), Input("cal", "dateClick"))
def show_click(date):
    return f"You clicked {date}" if date else "Click a date on the calendar."


@app.callback(
    Output("cal", "command"),
    Input("setprops", "n_clicks"),
    prevent_initial_call=True,
)
def rename_audit(n_clicks):
    """Update the Audit event's title and its `trainer` extendedProp in place.

    Because this goes through the `setProps` command rather than replacing the
    `events` prop, the Audit block is mutated on its existing DOM element (no
    remount) and its `data-trainer` mirror refreshes to the new value. `n_clicks`
    doubles as the nonce so repeated clicks change the command by reference.
    """
    return {
        "type": "setProps",
        "nonce": n_clicks,
        "updates": [
            {
                "id": "audit",
                "title": f"Audit (renamed x{n_clicks})",
                "extendedProps": {"trainer": "ZZ"},
            }
        ],
    }


@app.callback(
    Output("cal", "events"),
    Input("toggle", "n_clicks"),
    State("cal", "events"),
    prevent_initial_call=True,
)
def toggle_conflict(_n_clicks, events):
    """Move the conflict class to the other event by returning a new events list."""
    current = next(
        (
            e["id"]
            for e in events
            if "is-conflict-hard" in e.get("extendedProps", {}).get("classNames", [])
        ),
        None,
    )
    return build_events("golive" if current == "audit" else "audit")


if __name__ == "__main__":
    app.run(debug=True)
