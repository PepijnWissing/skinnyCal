from dash import Dash, html, Input, Output, State
from dash.exceptions import PreventUpdate
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
            # Native right-click bridge (skinnycal >= 0.4.0): right-clicking an
            # event, a day/time slot, or a resource lane emits `contextMenu`
            # (see the callback below). skinnycal emits the context only — the
            # app renders and positions the menu itself.
            contextMenuEnabled=True,
            # FullCalendar props passed unchanged:
            headerToolbar={"left": "prev,next today", "center": "title",
                           "right": "dayGridMonth,timeGridWeek"},
            events=build_events("audit"),
            eventDataAttributes=["trainer"],
        ),
        html.Div(id="clicked"),
        # App-owned context menu. skinnycal never renders this.
        html.Div(id="ctx-menu", style={"display": "none"}),
        # Hidden button an outside-click clicks to dismiss the menu *through*
        # Dash (see the dismissal callbacks below), plus a dummy output for the
        # one-time listener installer.
        html.Button(id="ctx-dismiss", style={"display": "none"}),
        html.Div(id="ctx-menu-init", style={"display": "none"}),
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


# Dismiss the app-owned menu on any left-click outside it. This is the app's
# job, not skinnycal's: skinnycal reports the right-click context but never
# renders or owns the menu, so it has nothing to hide.
#
# The dismissal must go THROUGH Dash, not by mutating the DOM directly: the open
# callback below owns `ctx-menu.style`, so if we set `display:'none'` behind
# React's back, React still believes the style is `display:'block'` and — on the
# next right-click, which returns `display:'block'` again — sees no change and
# never re-shows the menu (it stays hidden until a page refresh). So instead a
# one-time document listener just *clicks a hidden button*, and a clientside
# callback flips `ctx-menu.style` to hidden via Dash, keeping React in sync.
app.clientside_callback(
    """
    function(context) {
        if (!window.__skinnycalCtxBound) {
            window.__skinnycalCtxBound = true;
            document.addEventListener('mousedown', function(e) {
                var menu = document.getElementById('ctx-menu');
                if (!menu || menu.style.display === 'none') { return; }
                // Keep the menu open for clicks inside it (e.g. action items).
                if (menu.contains(e.target)) { return; }
                document.getElementById('ctx-dismiss').click();
            }, true);
        }
        return window.dash_clientside.no_update;
    }
    """,
    Output("ctx-menu-init", "children"),
    Input("cal", "contextMenu"),
    prevent_initial_call=True,
)

# Flip the menu to hidden through Dash so React's virtual DOM stays authoritative
# (allow_duplicate: the open callback also writes ctx-menu.style).
app.clientside_callback(
    "function(n) { return {'display': 'none'}; }",
    Output("ctx-menu", "style", allow_duplicate=True),
    Input("ctx-dismiss", "n_clicks"),
    prevent_initial_call=True,
)


@app.callback(
    Output("ctx-menu", "children"),
    Output("ctx-menu", "style"),
    Input("cal", "contextMenu"),
    prevent_initial_call=True,
)
def open_context_menu(context):
    """Render an app-owned menu at the pointer for a recognized right-click.

    skinnycal only reports *what* was right-clicked (target type + date /
    resource / event context + pointer coordinates) via the `contextMenu`
    prop; deciding the actions and drawing the menu is entirely the app's job.
    """
    if not context:
        raise PreventUpdate

    js = context["jsEvent"]
    target = context["target"]
    if target == "event":
        label = f"Event: {context['event']['title']}"
    elif target == "date":
        label = f"Date: {context['date']['start']}"
    else:
        label = f"Resource: {context['resource']['id']}"

    style = {
        "display": "block",
        "position": "fixed",
        "left": f"{js['clientX']}px",
        "top": f"{js['clientY']}px",
        "background": "#fff",
        "border": "1px solid #ccc",
        "borderRadius": "4px",
        "boxShadow": "0 2px 8px rgba(0,0,0,0.15)",
        "padding": "6px 10px",
        "zIndex": 1000,
    }
    return label, style


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
