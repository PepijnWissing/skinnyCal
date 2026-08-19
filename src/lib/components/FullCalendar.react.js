import React, {useRef, useEffect, useCallback, useMemo} from "react";
import PropTypes from "prop-types";

import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";
import multiMonthPlugin from "@fullcalendar/multimonth";

// Premium (Scheduler) plugins — statically imported so they are bundled into
// the single published min.js. Upstream loaded these via a dynamic import()
// that webpack split into async chunk files which were never shipped, so
// premium views silently failed to load. They still only activate when a
// schedulerLicenseKey is supplied (see premiumPlugins below).
import resourceTimelinePlugin from "@fullcalendar/resource-timeline";
import resourceTimeGridPlugin from "@fullcalendar/resource-timegrid";
import resourcePlugin from "@fullcalendar/resource";
import scrollGridPlugin from "@fullcalendar/scrollgrid";

import {buildContextMenuPayload} from "../contextMenu";


/**
 * Normalize FullCalendar's ClassNamesGenerator shape
 * (`string | string[] | (arg) => string | string[]`) into a plain array, so a
 * caller-supplied `eventClassNames` and the per-event `extendedProps.classNames`
 * channel can be concatenated instead of one clobbering the other.
 */
const toClassArray = (value, arg) => {
    const resolved = typeof value === 'function' ? value(arg) : value;
    if (!resolved) {
        return [];
    }
    if (Array.isArray(resolved)) {
        return resolved;
    }
    if (typeof resolved === 'string') {
        return resolved.split(/\s+/).filter(Boolean);
    }
    return [];
};

/**
 * camelCase -> kebab-case, so an `extendedProps` key mirrored by
 * `eventDataAttributes` lands as `data-course-code` and reads back as
 * `el.dataset.courseCode` (the standard HTML dataset mapping).
 */
const toDataAttrName = (key) => (
    'data-' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
);

/**
 * Mirror a whitelist of `extendedProps` keys from `event` onto DOM element `el`
 * as kebab-cased `data-*` attributes (see eventDataAttributes / toDataAttrName).
 * Shared by the mount hook (handleEventDidMount) and the in-place `setProps`
 * command so both stay consistent: on mount it stamps the initial values, and
 * after a mutation it refreshes them. `null`/missing values remove the stale
 * attribute (a no-op at mount, where nothing was set yet); objects/arrays are
 * JSON-encoded. Does not touch `data-event-id`.
 */
const mirrorEventDataAttributes = (el, event, keys) => {
    if (!Array.isArray(keys)) {
        return;
    }
    keys.forEach((key) => {
        const attr = toDataAttrName(key);
        const value = event.extendedProps[key];
        if (typeof value === 'undefined' || value === null) {
            el.removeAttribute(attr);
            return;
        }
        el.setAttribute(
            attr,
            typeof value === 'object' ? JSON.stringify(value) : String(value)
        );
    });
};

/**
 * DashFullCalendar – thin Dash wrapper around @fullcalendar/react.
 * ALL props (except the Dash house‑keeping ones) are forwarded verbatim.
 * No monkey‑patching of FullCalendar internals.
 */
const DashFullCalendar = ({
    id,
    setProps,
    command: _command,
    dateClick: _dateClick,
    eventClick: _eventClick,
    select: _select,
    unselect: _unselect,
    eventDrop: _eventDrop,
    eventResize: _eventResize,
    eventAdd: _eventAdd,
    eventChange: _eventChange,
    eventRemove: _eventRemove,
    datesSet: _datesSet,
    eventsSet: _eventsSet,
    // Hover bridges (data props, set by us; pulled out so stale values are not
    // forwarded to FullCalendar as options — our handlers are wired below).
    eventMouseEnter: _eventMouseEnter,
    eventMouseLeave: _eventMouseLeave,
    // Per-event decoration seam. These four are pulled out because we install
    // internal defaults for them; our handlers compose the caller's value in
    // rather than replacing it (see handleEventClassNames / handleEventDidMount /
    // handleEventWillUnmount).
    eventClassNames: userEventClassNames,
    eventDidMount: userEventDidMount,
    eventWillUnmount: userEventWillUnmount,
    eventDataAttributes,
    schedulerLicenseKey,
    plugins: userPlugins,
    // Native right-click bridge. Both are skinnycal-specific and must not be
    // forwarded to FullCalendar (contextMenu is an output data prop, like the
    // other bridged callbacks; contextMenuEnabled toggles the listener).
    contextMenuEnabled = false,
    contextMenu: _contextMenu,
    // anything else the user supplies:
    ...calendarProps
}) => {
    const calRef = useRef(null);
    // The skinnycal outer <div>. Right-click detection is scoped to it so
    // several calendars on one page never resolve against each other's DOM.
    const rootRef = useRef(null);
    // Monotonically increasing so two right-clicks at the identical location
    // still produce a distinct `contextMenu` value (Dash dedupes by value).
    const contextSequenceRef = useRef(0);
    // Maps a mounted event's DOM element -> its EventApi, as a fallback for
    // resolving anonymous events (no public id) under the pointer. Keyed weakly
    // so entries drop when FullCalendar unmounts the block.
    const mountedEventsRef = useRef(new WeakMap());
    // Holds the `info.revert()` callback from the most recent drag/resize, so a
    // `{type:"revert"}` command can undo it natively (see command handler).
    const lastRevertRef = useRef(null);
    // Latest eventDataAttributes, read by the command effect when it re-mirrors
    // data-* after a setProps mutation. Kept in a ref so the effect can stay
    // gated on `command` alone (see its deps) instead of re-firing — and thus
    // re-dispatching the last command — whenever this config prop changes.
    const eventDataAttributesRef = useRef(eventDataAttributes);
    eventDataAttributesRef.current = eventDataAttributes;

    // Resolve premium plugin name-strings to the statically-imported plugin
    // objects. Gated on schedulerLicenseKey to preserve the original API and
    // to avoid registering premium views without a key.
    const premiumPlugins = useMemo(() => {
        if (!schedulerLicenseKey || !Array.isArray(userPlugins)) {
            return [];
        }
        const nameToPlugin = {
            scrollgrid: scrollGridPlugin,
            resourcetimeline: resourceTimelinePlugin,
            resourcetimegrid: resourceTimeGridPlugin,
            resource: resourcePlugin
        };
        const resolved = userPlugins
            .filter((p) => typeof p === 'string')
            .map((s) => String(s).replace(/[-_\s]/g, '').toLowerCase())
            .map((n) => nameToPlugin[n])
            .filter(Boolean);
        // De-dupe; resource-timeline / -timegrid already pull resource + scrollgrid as deps.
        return [...new Set(resolved)];
    }, [userPlugins, schedulerLicenseKey]);

    const userPluginInstances = useMemo(() => (
        Array.isArray(userPlugins) ? userPlugins.filter((p) => typeof p !== 'string') : []
    ), [userPlugins]);

    /* ---------- Utility functions for serialization ---------- */

    const serializeEvent = (event) => ({
        id: event.id,
        groupId: event.groupId,
        allDay: event.allDay,
        startStr: event.startStr,
        endStr: event.endStr,
        title: event.title,
        url: event.url,
        classNames: event.classNames,
        editable: event.editable,
        startEditable: event.startEditable,
        durationEditable: event.durationEditable,
        resourceEditable: event.resourceEditable,
        display: event.display,
        overlap: event.overlap,
        constraint: event.constraint,
        backgroundColor: event.backgroundColor,
        borderColor: event.borderColor,
        textColor: event.textColor,
        extendedProps: event.extendedProps
    });

    const serializeDuration = (delta) => ({
        years: delta.years,
        months: delta.months,
        days: delta.days,
        milliseconds: delta.milliseconds
    });

    /* ---------- Command handling for API methods ---------- */

    useEffect(() => {
        const api = calRef.current?.getApi();
        if (!api || !_command) {return;}

        switch (_command.type) {
            case "next":
                api.next();
                break;
            case "prev":
                api.prev();
                break;
            case "today":
                api.today();
                break;
            case "changeView":
                if (_command.view) {
                    api.changeView(_command.view);
                }
                break;
            case "setResources": {
                // Move an event between resources (e.g. trainers) by id, using
                // FullCalendar's own EventApi.setResources (resource plugin).
                // resourceIds is an array of resource ids; FullCalendar replaces
                // the event's resource set with it.
                const ev = api.getEventById(_command.id);
                if (ev && Array.isArray(_command.resourceIds)) {
                    ev.setResources(_command.resourceIds);
                }
                break;
            }
            case "setDates": {
                // Reschedule an event by id, using EventApi.setDates. `end` may
                // be omitted (FullCalendar keeps/derives the duration).
                const ev = api.getEventById(_command.id);
                if (ev && _command.start) {
                    ev.setDates(
                        _command.start,
                        _command.end || null,
                        _command.options || {}
                    );
                }
                break;
            }
            case "setProps": {
                // In-place update of an existing event's title / extendedProps
                // by id, using EventApi.setProp / setExtendedProp, so a wrapper
                // app can change event data WITHOUT replacing the whole `events`
                // prop (which remounts every block). Accepts a batch
                // (`updates: [{id, title?, extendedProps?}, ...]`) or the
                // single-event shorthand ({id, title?, extendedProps?}) for
                // symmetry with setDates.
                const updates = Array.isArray(_command.updates)
                    ? _command.updates
                    : [_command];
                updates.forEach((upd) => {
                    if (!upd || !upd.id) {
                        return;
                    }
                    const ev = api.getEventById(upd.id);
                    if (!ev) {
                        // Skip missing ids silently.
                        return;
                    }
                    if (typeof upd.title !== "undefined") {
                        ev.setProp("title", upd.title);
                    }
                    if (upd.extendedProps && typeof upd.extendedProps === "object") {
                        Object.keys(upd.extendedProps).forEach((key) => {
                            ev.setExtendedProp(key, upd.extendedProps[key]);
                        });
                    }
                    // Re-mirror data-* onto this event's block root(s): the
                    // mount hook only runs at mount, so an in-place mutation
                    // would otherwise leave stale data-* attributes. Match on
                    // the stamped data-event-id (unchanged here) rather than
                    // building an escaped selector from a caller-supplied id.
                    if (api.el) {
                        api.el
                            .querySelectorAll("[data-event-id]")
                            .forEach((el) => {
                                if (el.getAttribute("data-event-id") === String(upd.id)) {
                                    mirrorEventDataAttributes(
                                        el,
                                        ev,
                                        eventDataAttributesRef.current
                                    );
                                }
                            });
                    }
                });
                break;
            }
            case "revert":
                // Undo the most recent drag/resize (calls FullCalendar's own
                // info.revert(), captured at drop/resize time). One-shot.
                if (lastRevertRef.current) {
                    lastRevertRef.current();
                    lastRevertRef.current = null;
                }
                break;
            // Add more commands as needed
            default:
                // Unknown command
                break;
        }
    }, [_command]);

    /* ---------- Dash ↔ FullCalendar event bridges ---------- */

    const handleDateClick = useCallback(
        (info) => {
            if (setProps) {
                setProps({dateClick: info.dateStr});
            }
        },
        [setProps]
    );

    const handleEventClick = useCallback(
        (info) => {
            if (setProps) {
                setProps({
                    eventClick: {
                        id: info.event.id,
                        title: info.event.title,
                        start: info.event.startStr,
                        end: info.event.endStr,
                        allDay: info.event.allDay,
                        extendedProps: info.event.extendedProps
                    }
                });
            }
        },
        [setProps]
    );

    const handleSelect = useCallback(
        (info) => {
            if (setProps) {
                setProps({
                    select: {
                        start: info.startStr,
                        end: info.endStr,
                        allDay: info.allDay
                    }
                });
            }
        },
        [setProps]
    );

    const handleUnselect = useCallback(
        (_info) => {
            if (setProps) {
                setProps({unselect: true});
            }
        },
        [setProps]
    );

    const handleEventDrop = useCallback(
        (info) => {
            // Remember how to undo this drop, for a later {type:"revert"}.
            lastRevertRef.current = info.revert;
            if (setProps) {
                setProps({
                    eventDrop: {
                        event: serializeEvent(info.event),
                        oldEvent: serializeEvent(info.oldEvent),
                        delta: serializeDuration(info.delta),
                        relatedEvents: info.relatedEvents.map(serializeEvent),
                        // Resource (e.g. trainer) the event moved between, in
                        // resource views. Only set by FullCalendar when the
                        // resource actually changed; null otherwise.
                        oldResource: info.oldResource ? info.oldResource.id : null,
                        newResource: info.newResource ? info.newResource.id : null
                    }
                });
            }
        },
        [setProps]
    );

    const handleEventResize = useCallback(
        (info) => {
            // Remember how to undo this resize, for a later {type:"revert"}.
            lastRevertRef.current = info.revert;
            if (setProps) {
                setProps({
                    eventResize: {
                        event: serializeEvent(info.event),
                        oldEvent: serializeEvent(info.oldEvent),
                        delta: serializeDuration(info.delta),
                        relatedEvents: info.relatedEvents.map(serializeEvent)
                    }
                });
            }
        },
        [setProps]
    );

    const handleEventAdd = useCallback(
        (arg) => {
            if (setProps) {
                setProps({
                    eventAdd: {
                        event: serializeEvent(arg.event)
                    }
                });
            }
        },
        [setProps]
    );

    const handleEventChange = useCallback(
        (arg) => {
            if (setProps) {
                setProps({
                    eventChange: {
                        event: serializeEvent(arg.event),
                        oldEvent: serializeEvent(arg.oldEvent),
                        relatedEvents: arg.relatedEvents.map(serializeEvent)
                    }
                });
            }
        },
        [setProps]
    );

    const handleEventRemove = useCallback(
        (arg) => {
            if (setProps) {
                setProps({
                    eventRemove: {
                        event: serializeEvent(arg.event),
                        relatedEvents: arg.relatedEvents.map(serializeEvent)
                    }
                });
            }
        },
        [setProps]
    );

    const handleDatesSet = useCallback(
        (info) => {
            if (setProps) {
                setProps({
                    datesSet: {
                        start: info.startStr,
                        end: info.endStr,
                        viewType: info.view.type
                    }
                });
            }
        },
        [setProps]
    );

    const handleEventsSet = useCallback(
        (events) => {
            if (setProps) {
                setProps({
                    eventsSet: events.map(serializeEvent)
                });
            }
        },
        [setProps]
    );

    const handleEventMouseEnter = useCallback(
        (info) => {
            if (setProps) {
                setProps({
                    eventMouseEnter: {
                        id: info.event.id,
                        title: info.event.title,
                        start: info.event.startStr,
                        end: info.event.endStr,
                        extendedProps: info.event.extendedProps,
                        // Pointer position so a Dash tooltip can be placed.
                        jsEvent: info.jsEvent
                            ? {pageX: info.jsEvent.pageX, pageY: info.jsEvent.pageY}
                            : null
                    }
                });
            }
        },
        [setProps]
    );

    const handleEventMouseLeave = useCallback(
        (info) => {
            if (setProps) {
                setProps({eventMouseLeave: {id: info.event.id}});
            }
        },
        [setProps]
    );

    /* ---------- Per-event decoration seam ---------- */

    // Declarative per-event class channel: an event dict may carry
    // `extendedProps.classNames`, which becomes real classes on that block's
    // `.fc-event` root. FullCalendar re-evaluates eventClassNames whenever the
    // event's data changes, so Dash can toggle conflict/role state by updating
    // only the affected events. Composes with a caller-supplied eventClassNames.
    const handleEventClassNames = useCallback(
        (arg) => [
            ...toClassArray(userEventClassNames, arg),
            ...toClassArray(arg.event.extendedProps.classNames)
        ],
        [userEventClassNames]
    );

    // Stable per-event DOM hook: stamp the event's public id onto the block root
    // so wrapper JS can select `[data-event-id="<id>"]` instead of reaching into
    // FullCalendar's internal `el.fcSeg`. Optionally mirrors whitelisted
    // extendedProps keys as `data-*` too (see eventDataAttributes).
    const handleEventDidMount = useCallback(
        (info) => {
            // Guarded: events without an id would otherwise all collect
            // data-event-id="", making `[data-event-id]` useless as a selector.
            if (info.event.id) {
                info.el.setAttribute("data-event-id", info.event.id);
            }
            mirrorEventDataAttributes(info.el, info.event, eventDataAttributes);
            // Remember this element -> EventApi so the context-menu bridge can
            // resolve anonymous events (no public id) that getEventById can't.
            mountedEventsRef.current.set(info.el, info.event);
            // Last, so a caller-supplied handler can inspect or override.
            if (typeof userEventDidMount === "function") {
                userEventDidMount(info);
            }
        },
        [eventDataAttributes, userEventDidMount]
    );

    // Drop the WeakMap entry when the block unmounts, then defer to the caller.
    const handleEventWillUnmount = useCallback(
        (info) => {
            mountedEventsRef.current.delete(info.el);
            if (typeof userEventWillUnmount === "function") {
                userEventWillUnmount(info);
            }
        },
        [userEventWillUnmount]
    );

    /* ---------- Native right-click (contextmenu) bridge ---------- */

    // One delegated listener on the skinnycal root. Installed only when
    // contextMenuEnabled; the browser menu is suppressed *only* for a
    // recognized calendar target, so right-clicks on toolbar chrome keep it.
    useEffect(() => {
        const root = rootRef.current;
        if (!contextMenuEnabled || !root) {
            return () => {};
        }

        const handleContextMenu = (jsEvent) => {
            const payload = buildContextMenuPayload({
                root,
                api: calRef.current?.getApi(),
                jsEvent,
                mountedEvents: mountedEventsRef.current,
                calendarId: id,
                sequence: ++contextSequenceRef.current
            });
            if (!payload) {
                // Unrecognized chrome: leave the native menu alone.
                return;
            }
            jsEvent.preventDefault();
            if (setProps) {
                setProps({contextMenu: payload});
            }
        };

        // Capture phase: FullCalendar / nested app content might otherwise
        // stopPropagation. We intentionally don't stopPropagation ourselves so
        // other app-level observers still see the event.
        root.addEventListener("contextmenu", handleContextMenu, true);
        return () => {
            root.removeEventListener("contextmenu", handleContextMenu, true);
        };
    }, [contextMenuEnabled, id, setProps]);

    return (
        <div id={id} ref={rootRef}>
            <FullCalendar
                ref={calRef}
                plugins={[
                    dayGridPlugin,
                    timeGridPlugin,
                    interactionPlugin,
                    listPlugin,
                    multiMonthPlugin,
                    ...premiumPlugins,
                    ...userPluginInstances
                ]}
                // Always pass the key if provided. Harmless for free plugins; avoids missing key when a user supplies a Premium plugin instance directly.
                {...(schedulerLicenseKey ? { schedulerLicenseKey } : {})}
                {...calendarProps}
                dateClick={handleDateClick}
                eventClick={handleEventClick}
                select={handleSelect}
                unselect={handleUnselect}
                eventDrop={handleEventDrop}
                eventResize={handleEventResize}
                eventAdd={handleEventAdd}
                eventChange={handleEventChange}
                eventRemove={handleEventRemove}
                datesSet={handleDatesSet}
                eventsSet={handleEventsSet}
                eventMouseEnter={handleEventMouseEnter}
                eventMouseLeave={handleEventMouseLeave}
                eventClassNames={handleEventClassNames}
                eventDidMount={handleEventDidMount}
                eventWillUnmount={handleEventWillUnmount}
            />
        </div>
    );
};

/* ---------- Dash mandatory metadata ---------- */

DashFullCalendar.propTypes = {
    /**
     * Unique HTML id for the calendar container.  See FullCalendar docs.
     */
    id: PropTypes.string,

    // Core FullCalendar props (all free edition options, excluding bridged callbacks which are defined below as any)
    /**
     * Name of the view the calendar shows on first load.  See FullCalendar docs.
     */
    initialView: PropTypes.string,
    /**
     * Array, URL, or function that supplies the initial events.  See FullCalendar docs.
     */
    events: PropTypes.oneOfType([
        PropTypes.array,
        PropTypes.string,
        PropTypes.func
    ]),
    /**
     * Config for the top toolbar; set `false` to hide.  See FullCalendar docs.
     */
    headerToolbar: PropTypes.oneOfType([PropTypes.object, PropTypes.bool]),
    /**
     * Config for the bottom toolbar; set `false` to hide.  See FullCalendar docs.
     */
    footerToolbar: PropTypes.oneOfType([PropTypes.object, PropTypes.bool]),
    /**
     * Custom button definitions keyed by name.  See FullCalendar docs.
     */
    customButtons: PropTypes.object,
    /**
     * Icon class strings mapped to built-in button names.  See FullCalendar docs.
     */
    buttonIcons: PropTypes.object,
    /**
     * Override text labels for built-in buttons.  See FullCalendar docs.
     */
    buttonText: PropTypes.object,
    /**
     * Theme system to apply to built-in UI (e.g. ‘standard’, ‘bootstrap5’).  See FullCalendar docs.
     */
    themeSystem: PropTypes.string,
    /**
     * Overall calendar height (`number`, ‘auto’, ‘parent’, or function).  See FullCalendar docs.
     */
    height: PropTypes.oneOfType([PropTypes.number, PropTypes.string, PropTypes.func]),
    /**
     * Height of the scrollable content area.  See FullCalendar docs.
     */
    contentHeight: PropTypes.oneOfType([PropTypes.number, PropTypes.string, PropTypes.func]),
    /**
     * Width/height ratio when `height` is auto.  See FullCalendar docs.
     */
    aspectRatio: PropTypes.number,
    /**
     * When `true`, rows stretch to fill vertical space.  See FullCalendar docs.
     */
    expandRows: PropTypes.bool,
    /**
     * Recompute dimensions on window resize.  See FullCalendar docs.
     */
    handleWindowResize: PropTypes.bool,
    /**
     * Debounce (ms) for the resize handler.  See FullCalendar docs.
     */
    windowResizeDelay: PropTypes.number,
    /**
     * Keep date headers fixed while scrolling.  See FullCalendar docs.
     */
    stickyHeaderDates: PropTypes.bool,
    /**
     * Show sticky scrollbar at the bottom.  See FullCalendar docs.
     */
    stickyFooterScrollbar: PropTypes.bool,
    /**
     * Date the calendar navigates to on first render.  See FullCalendar docs.
     */
    initialDate: PropTypes.oneOfType([PropTypes.string, PropTypes.instanceOf(Date)]),
    /**
     * Restricts navigation/selection to a date range.  See FullCalendar docs.
     */
    validRange: PropTypes.oneOfType([PropTypes.object, PropTypes.func]),
    /**
     * Precisely set the range of dates shown in a custom view.  See FullCalendar docs.
     */
    visibleRange: PropTypes.func,
    /**
     * Date-formatting skeleton or object for the view title.  See FullCalendar docs.
     */
    titleFormat: PropTypes.oneOfType([PropTypes.object, PropTypes.string]),
    /**
     * Calendar locale code (e.g. ‘en-gb’).  See FullCalendar docs.
     */
    locale: PropTypes.string,
    /**
     * Array of additional locale objects to load.  See FullCalendar docs.
     */
    locales: PropTypes.array,
    /**
     * Text direction: ‘ltr’ or ‘rtl’.  See FullCalendar docs.
     */
    dir: PropTypes.string,
    /**
     * Index of week’s first day (0=Sunday).  See FullCalendar docs.
     */
    firstDay: PropTypes.number,
    /**
     * Show weekend columns.  See FullCalendar docs.
     */
    weekends: PropTypes.bool,
    /**
     * Array of day numbers to hide (0=Sun).  See FullCalendar docs.
     */
    hiddenDays: PropTypes.array,
    /**
     * Always render 6 weeks in month view.  See FullCalendar docs.
     */
    fixedWeekCount: PropTypes.bool,
    /**
     * Render leading/trailing days in month view.  See FullCalendar docs.
     */
    showNonCurrentDates: PropTypes.bool,
    /**
     * Collapse rows after this many events per day.  See FullCalendar docs.
     */
    dayMaxEvents: PropTypes.oneOfType([PropTypes.bool, PropTypes.number]),
    /**
     * Alternate way to cap events per day (rows).  See FullCalendar docs.
     */
    dayMaxEventRows: PropTypes.oneOfType([PropTypes.bool, PropTypes.number]),
    /**
     * Minimum pixel width of a day column.  See FullCalendar docs.
     */
    dayMinWidth: PropTypes.number,
    /**
     * Action when a ‘+ more’ link is clicked.  See FullCalendar docs.
     */
    moreLinkClick: PropTypes.oneOfType([PropTypes.string, PropTypes.func]),
    /**
     * Custom renderer for the ‘+ more’ link.  See FullCalendar docs.
     */
    moreLinkContent: PropTypes.oneOfType([PropTypes.func, PropTypes.node]),
    /**
     * Text factory for the ‘+ more’ link.  See FullCalendar docs.
     */
    moreLinkText: PropTypes.oneOfType([PropTypes.string, PropTypes.func]),
    /**
     * Class names for the ‘+ more’ link.  See FullCalendar docs.
     */
    moreLinkClassNames: PropTypes.oneOfType([PropTypes.array, PropTypes.object, PropTypes.string, PropTypes.func]),
    /**
     * Callback after the ‘+ more’ link mounts.  See FullCalendar docs.
     */
    moreLinkDidMount: PropTypes.func,
    /**
     * Callback before the ‘+ more’ link unmounts.  See FullCalendar docs.
     */
    moreLinkWillUnmount: PropTypes.func,
    /**
     * Date-format skeleton for the day popover.  See FullCalendar docs.
     */
    dayPopoverFormat: PropTypes.oneOfType([PropTypes.object, PropTypes.string]),
    /**
     * Show ISO week numbers down the side.  See FullCalendar docs.
     */
    weekNumbers: PropTypes.bool,
    /**
     * Formatter for week-number text.  See FullCalendar docs.
     */
    weekNumberFormat: PropTypes.oneOfType([PropTypes.object, PropTypes.string]),
    /**
     * Custom week-number algorithm.  See FullCalendar docs.
     */
    weekNumberCalculation: PropTypes.oneOfType([PropTypes.string, PropTypes.func]),
    /**
     * Short label preceding week numbers.  See FullCalendar docs.
     */
    weekText: PropTypes.string,
    /**
     * Long label preceding week numbers.  See FullCalendar docs.
     */
    weekTextLong: PropTypes.string,
    /**
     * Business-hours definition(s) or `true` for default.  See FullCalendar docs.
     */
    businessHours: PropTypes.oneOfType([PropTypes.bool, PropTypes.object, PropTypes.array]),
    /**
     * Function/string/Date returning the ‘current’ date.  See FullCalendar docs.
     */
    now: PropTypes.oneOfType([PropTypes.string, PropTypes.instanceOf(Date), PropTypes.func]),
    /**
     * Render a line marking the current time.  See FullCalendar docs.
     */
    nowIndicator: PropTypes.bool,
    /**
     * Initial scroll position of time-grid views.  See FullCalendar docs.
     */
    scrollTime: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
    /**
     * Reset scroll position when changing views.  See FullCalendar docs.
     */
    scrollTimeReset: PropTypes.bool,
    /**
     * Granularity of the vertical time slots.  See FullCalendar docs.
     */
    slotDuration: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
    /**
     * Interval between slot labels.  See FullCalendar docs.
     */
    slotLabelInterval: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
    /**
     * Formatter(s) for slot labels.  See FullCalendar docs.
     */
    slotLabelFormat: PropTypes.oneOfType([PropTypes.array, PropTypes.object, PropTypes.string]),
    /**
     * Earliest time shown on a day.  See FullCalendar docs.
     */
    slotMinTime: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
    /**
     * Latest time shown on a day.  See FullCalendar docs.
     */
    slotMaxTime: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
    /**
     * Minimum pixel width of a resource column.  See FullCalendar docs.
     */
    slotMinWidth: PropTypes.number,
    /**
     * Grid snapping interval while dragging.  See FullCalendar docs.
     */
    snapDuration: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
    /**
     * Display the all-day row in time-grid views.  See FullCalendar docs.
     */
    allDaySlot: PropTypes.bool,
    /**
     * Text label for the all-day slot.  See FullCalendar docs.
     */
    allDayText: PropTypes.string,
    /**
     * Class names for the all-day row.  See FullCalendar docs.
     */
    allDayClassNames: PropTypes.oneOfType([PropTypes.array, PropTypes.object, PropTypes.string, PropTypes.func]),
    /**
     * Custom renderer for the all-day cell.  See FullCalendar docs.
     */
    allDayContent: PropTypes.oneOfType([PropTypes.func, PropTypes.node]),
    /**
     * Callback after the all-day row mounts.  See FullCalendar docs.
     */
    allDayDidMount: PropTypes.func,
    /**
     * Callback before the all-day row unmounts.  See FullCalendar docs.
     */
    allDayWillUnmount: PropTypes.func,
    /**
     * Class names for resource lanes.  See FullCalendar docs.
     */
    slotLaneClassNames: PropTypes.oneOfType([PropTypes.array, PropTypes.object, PropTypes.string, PropTypes.func]),
    /**
     * Custom renderer for resource lanes.  See FullCalendar docs.
     */
    slotLaneContent: PropTypes.oneOfType([PropTypes.func, PropTypes.node]),
    /**
     * Callback after a lane mounts.  See FullCalendar docs.
     */
    slotLaneDidMount: PropTypes.func,
    /**
     * Callback before a lane unmounts.  See FullCalendar docs.
     */
    slotLaneWillUnmount: PropTypes.func,
    /**
     * Class names for slot labels.  See FullCalendar docs.
     */
    slotLabelClassNames: PropTypes.oneOfType([PropTypes.array, PropTypes.object, PropTypes.string, PropTypes.func]),
    /**
     * Custom renderer for slot labels.  See FullCalendar docs.
     */
    slotLabelContent: PropTypes.oneOfType([PropTypes.func, PropTypes.node]),
    /**
     * Callback after a slot label mounts.  See FullCalendar docs.
     */
    slotLabelDidMount: PropTypes.func,
    /**
     * Callback before a slot label unmounts.  See FullCalendar docs.
     */
    slotLabelWillUnmount: PropTypes.func,
    /**
     * Formatter for day-header text.  See FullCalendar docs.
     */
    dayHeaderFormat: PropTypes.oneOfType([PropTypes.object, PropTypes.string]),
    /**
     * Class names for day headers.  See FullCalendar docs.
     */
    dayHeaderClassNames: PropTypes.oneOfType([PropTypes.array, PropTypes.object, PropTypes.string, PropTypes.func]),
    /**
     * Custom renderer for day headers.  See FullCalendar docs.
     */
    dayHeaderContent: PropTypes.oneOfType([PropTypes.func, PropTypes.node]),
    /**
     * Callback after a day header mounts.  See FullCalendar docs.
     */
    dayHeaderDidMount: PropTypes.func,
    /**
     * Callback before a day header unmounts.  See FullCalendar docs.
     */
    dayHeaderWillUnmount: PropTypes.func,
    /**
     * Class names for day cells.  See FullCalendar docs.
     */
    dayCellClassNames: PropTypes.oneOfType([PropTypes.array, PropTypes.object, PropTypes.string, PropTypes.func]),
    /**
     * Custom renderer for day cells.  See FullCalendar docs.
     */
    dayCellContent: PropTypes.oneOfType([PropTypes.func, PropTypes.node]),
    /**
     * Callback after a day cell mounts.  See FullCalendar docs.
     */
    dayCellDidMount: PropTypes.func,
    /**
     * Callback before a day cell unmounts.  See FullCalendar docs.
     */
    dayCellWillUnmount: PropTypes.func,
    /**
     * Formatter for list view group headers.  See FullCalendar docs.
     */
    listDayFormat: PropTypes.oneOfType([PropTypes.object, PropTypes.string, PropTypes.bool]),
    /**
     * Formatter for list view side headers.  See FullCalendar docs.
     */
    listDaySideFormat: PropTypes.oneOfType([PropTypes.object, PropTypes.string, PropTypes.bool]),
    /**
     * Class names applied when no events are present.  See FullCalendar docs.
     */
    noEventsClassNames: PropTypes.oneOfType([PropTypes.array, PropTypes.object, PropTypes.string, PropTypes.func]),
    /**
     * Custom ‘no events’ content renderer.  See FullCalendar docs.
     */
    noEventsContent: PropTypes.oneOfType([PropTypes.func, PropTypes.node]),
    /**
     * Callback after ‘no events’ content mounts.  See FullCalendar docs.
     */
    noEventsDidMount: PropTypes.func,
    /**
     * Callback before ‘no events’ content unmounts.  See FullCalendar docs.
     */
    noEventsWillUnmount: PropTypes.func,
    /**
     * Enable day/week navigation links.  See FullCalendar docs.
     */
    navLinks: PropTypes.bool,
    /**
     * Handler for day navigation link clicks.  See FullCalendar docs.
     */
    navLinkDayClick: PropTypes.oneOfType([PropTypes.func, PropTypes.string]),
    /**
     * Handler for week navigation link clicks.  See FullCalendar docs.
     */
    navLinkWeekClick: PropTypes.oneOfType([PropTypes.func, PropTypes.string]),
    /**
     * Tooltip for navigation links.  See FullCalendar docs.
     */
    navLinkHint: PropTypes.oneOfType([PropTypes.string, PropTypes.func]),
    /**
     * Max columns in multi-month view.  See FullCalendar docs.
     */
    multiMonthMaxColumns: PropTypes.number,
    /**
     * Min width for multi-month columns.  See FullCalendar docs.
     */
    multiMonthMinWidth: PropTypes.number,
    /**
     * Title format for multi-month view.  See FullCalendar docs.
     */
    multiMonthTitleFormat: PropTypes.oneOfType([PropTypes.object, PropTypes.string]),
    /**
     * Custom view definitions mapped by name.  See FullCalendar docs.
     */
    views: PropTypes.object,
    /**
     * Additional plugins. Accepts plugin instances (objects/functions) and/or plugin names (strings).
     * If strings match Premium plugins (e.g., 'scrollgrid', 'resourceTimeline', 'resourceTimeGrid', 'resource'),
     * they will be lazy-loaded only when `schedulerLicenseKey` is provided. Unknown strings are ignored.
     */
    plugins: PropTypes.arrayOf(PropTypes.oneOfType([
        PropTypes.string,
        PropTypes.object,
        PropTypes.func
    ])),
    /**
     * FullCalendar Premium (Scheduler) license key. Required when using any Premium plugin
     * such as resource views or scrollgrid. See docs: https://fullcalendar.io/docs/schedulerLicenseKey
     */
    schedulerLicenseKey: PropTypes.string,
    /**
     * Array of resource objects used by Scheduler (Premium) resource views
     * (e.g. one lane per trainer), or a URL/function supplying them. Forwarded
     * verbatim to FullCalendar. See FullCalendar docs.
     */
    resources: PropTypes.oneOfType([
        PropTypes.array,
        PropTypes.string,
        PropTypes.func
    ]),
    /**
     * Array of event source objects.  See FullCalendar docs.
     */
    eventSources: PropTypes.array,
    /**
     * Default all-day status for new events.  See FullCalendar docs.
     */
    defaultAllDay: PropTypes.bool,
    /**
     * Formatter for event time text.  See FullCalendar docs.
     */
    eventTimeFormat: PropTypes.oneOfType([PropTypes.object, PropTypes.string]),
    /**
     * Show event time.  See FullCalendar docs.
     */
    displayEventTime: PropTypes.bool,
    /**
     * Show event end time.  See FullCalendar docs.
     */
    displayEventEnd: PropTypes.bool,
    /**
     * Threshold for "next day" calculation.  See FullCalendar docs.
     */
    nextDayThreshold: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
    /**
     * Rendering style for events.  See FullCalendar docs.
     */
    eventDisplay: PropTypes.string,
    /**
     * Default background color for events.  See FullCalendar docs.
     */
    eventBackgroundColor: PropTypes.string,
    /**
     * Default border color for events.  See FullCalendar docs.
     */
    eventBorderColor: PropTypes.string,
    /**
     * Default text color for events.  See FullCalendar docs.
     */
    eventTextColor: PropTypes.string,
    /**
     * Default color for events.  See FullCalendar docs.
     */
    eventColor: PropTypes.string,
    /**
     * Determines event sort order.  See FullCalendar docs.
     */
    eventOrder: PropTypes.oneOfType([PropTypes.array, PropTypes.string, PropTypes.func]),
    /**
     * Enforce strict event ordering.  See FullCalendar docs.
     */
    eventOrderStrict: PropTypes.bool,
    /**
     * Class names applied to every event block. Composed with — not replaced by —
     * the per-event `extendedProps.classNames` channel: any event dict carrying
     * `{"extendedProps": {"classNames": ["is-conflict-hard", ...]}}` gets those
     * classes on its `.fc-event` root, and FullCalendar re-evaluates them when
     * the event's data changes, so Dash can toggle per-block state by updating
     * only the affected events. (FullCalendar's native top-level `classNames`
     * key on an event object also still works and is merged in by FullCalendar.)
     * See FullCalendar docs.
     */
    eventClassNames: PropTypes.oneOfType([PropTypes.array, PropTypes.object, PropTypes.string, PropTypes.func]),
    /**
     * Custom renderer for events.  See FullCalendar docs.
     */
    eventContent: PropTypes.oneOfType([PropTypes.func, PropTypes.node]),
    /**
     * List of `extendedProps` keys to mirror onto each event block's `.fc-event`
     * root as `data-*` attributes, so wrapper JS can read event data off the DOM
     * instead of FullCalendar internals. Keys are kebab-cased
     * (`courseCode` -> `data-course-code`, i.e. `el.dataset.courseCode`);
     * `null`/missing values are skipped and objects/arrays are JSON-encoded.
     *
     * Every block additionally always gets `data-event-id="<event.id>"` (for
     * events that have a non-empty id), which needs no configuration.
     *
     * Caveat: mirroring happens when the block mounts. Replacing the `events`
     * prop re-parses the source, so blocks remount and the attributes refresh.
     * In-place `command` mutations that only move an event (`setDates`,
     * `setResources`) and drag/resize reuse the existing element without
     * re-running the mount hook and do not change `extendedProps`, so their
     * mirrors are left as-is (correctly — the values didn't change). The one
     * command that DOES change `extendedProps`, `setProps`, re-mirrors the
     * affected keys onto the reused element itself, so a key you mutate via
     * `setProps` stays consistent with the DOM.
     */
    eventDataAttributes: PropTypes.arrayOf(PropTypes.string),
    /**
     * Callback after an event is mounted.  See FullCalendar docs. Not usable from
     * Dash (functions cannot cross the Python↔JS boundary, so
     * dash-generate-components drops `func` props); when supplied from React it
     * runs after skinnycal's own handler has stamped `data-event-id` and any
     * `eventDataAttributes`.
     */
    eventDidMount: PropTypes.func,
    /**
     * Callback before an event is unmounted.  See FullCalendar docs.
     */
    eventWillUnmount: PropTypes.func,
    /**
     * Transform event data before rendering.  See FullCalendar docs.
     */
    eventDataTransform: PropTypes.func,
    /**
     * Name of start date GET param.  See FullCalendar docs.
     */
    startParam: PropTypes.string,
    /**
     * Name of end date GET param.  See FullCalendar docs.
     */
    endParam: PropTypes.string,
    /**
     * Name of time zone GET param.  See FullCalendar docs.
     */
    timeZoneParam: PropTypes.string,
    /**
     * Fetch events only when needed.  See FullCalendar docs.
     */
    lazyFetching: PropTypes.bool,
    /**
     * Render events as they load.  See FullCalendar docs.
     */
    progressiveEventRendering: PropTypes.bool,
    /**
     * Delay before rerendering events.  See FullCalendar docs.
     */
    rerenderDelay: PropTypes.number,
    /**
     * Callback for loading state.  See FullCalendar docs.
     */
    loading: PropTypes.func,
    /**
     * Allow events to be editable.  See FullCalendar docs.
     */
    editable: PropTypes.bool,
    /**
     * Allow event start to be editable.  See FullCalendar docs.
     */
    eventStartEditable: PropTypes.bool,
    /**
     * Allow resizing events from start.  See FullCalendar docs.
     */
    eventResizableFromStart: PropTypes.bool,
    /**
     * Allow event duration to be editable.  See FullCalendar docs.
     */
    eventDurationEditable: PropTypes.bool,
    /**
     * Duration for drag revert animation.  See FullCalendar docs.
     */
    dragRevertDuration: PropTypes.number,
    /**
     * Allow calendar to scroll during drag.  See FullCalendar docs.
     */
    dragScroll: PropTypes.bool,
    /**
     * Allow external elements to be dropped.  See FullCalendar docs.
     */
    droppable: PropTypes.bool,
    /**
     * Selector or function to accept drops.  See FullCalendar docs.
     */
    dropAccept: PropTypes.oneOfType([PropTypes.string, PropTypes.func]),
    /**
     * Allow events to overlap.  See FullCalendar docs.
     */
    eventOverlap: PropTypes.oneOfType([PropTypes.bool, PropTypes.func]),
    /**
     * Event constraint for dragging/resizing.  See FullCalendar docs.
     */
    eventConstraint: PropTypes.oneOfType([PropTypes.object, PropTypes.string]),
    /**
     * Determines if an event can be moved/resized.  See FullCalendar docs.
     */
    eventAllow: PropTypes.func,
    /**
     * Allow date/time range selection.  See FullCalendar docs.
     */
    selectable: PropTypes.bool,
    /**
     * Show a mirror of selection while dragging.  See FullCalendar docs.
     */
    selectMirror: PropTypes.bool,
    /**
     * Unselect when clicking outside.  See FullCalendar docs.
     */
    unselectAuto: PropTypes.bool,
    /**
     * CSS selector for elements that prevent unselect.  See FullCalendar docs.
     */
    unselectCancel: PropTypes.string,
    /**
     * Allow selection to overlap events.  See FullCalendar docs.
     */
    selectOverlap: PropTypes.oneOfType([PropTypes.bool, PropTypes.func]),
    /**
     * Selection constraint for selecting.  See FullCalendar docs.
     */
    selectConstraint: PropTypes.oneOfType([PropTypes.object, PropTypes.string]),
    /**
     * Determines if a selection is allowed.  See FullCalendar docs.
     */
    selectAllow: PropTypes.func,
    /**
     * Minimum drag distance before selection.  See FullCalendar docs.
     */
    selectMinDistance: PropTypes.number,
    /**
     * Delay for long press (ms).  See FullCalendar docs.
     */
    longPressDelay: PropTypes.number,
    /**
     * Delay for event long press (ms).  See FullCalendar docs.
     */
    eventLongPressDelay: PropTypes.number,
    /**
     * Delay for select long press (ms).  See FullCalendar docs.
     */
    selectLongPressDelay: PropTypes.number,
    /**
     * Class names for the view container.  See FullCalendar docs.
     */
    viewClassNames: PropTypes.oneOfType([PropTypes.array, PropTypes.object, PropTypes.string, PropTypes.func]),
    /**
     * Callback after a view is mounted.  See FullCalendar docs.
     */
    viewDidMount: PropTypes.func,
    /**
     * Callback before a view is unmounted.  See FullCalendar docs.
     */
    viewWillUnmount: PropTypes.func,
    /**
     * Object describing the event the pointer entered (id, title, start, end,
     * extendedProps, jsEvent.pageX/pageY), for use in Dash callbacks. Typed
     * `any` (not `func`) so dash-generate-components exposes it as a Dash prop.
     */
    eventMouseEnter: PropTypes.any,
    /**
     * Object ({id}) describing the event the pointer left, for use in Dash
     * callbacks. Typed `any` (not `func`) so it is exposed as a Dash prop.
     */
    eventMouseLeave: PropTypes.any,
    /**
     * Event drag starts.  See FullCalendar docs.
     */
    eventDragStart: PropTypes.func,
    /**
     * Event drag stops.  See FullCalendar docs.
     */
    eventDragStop: PropTypes.func,
    /**
     * Event resize starts.  See FullCalendar docs.
     */
    eventResizeStart: PropTypes.func,
    /**
     * Event resize stops.  See FullCalendar docs.
     */
    eventResizeStop: PropTypes.func,
    /**
     * Callback for drop of external elements.  See FullCalendar docs.
     */
    drop: PropTypes.func,
    /**
     * Callback when an external event is received.  See FullCalendar docs.
     */
    eventReceive: PropTypes.func,
    /**
     * Callback when an external event is removed.  See FullCalendar docs.
     */
    eventLeave: PropTypes.func,

    /**
     * Enable native browser context-menu (right-click) detection inside
     * recognized calendar events, date/time slots, and resource lanes.
     * Disabled by default. When false no listener is installed and the browser
     * menu behaves normally everywhere. When true, right-clicking a recognized
     * calendar target emits `contextMenu` and suppresses the browser menu for
     * that target only; right-clicks on toolbar controls or other unrecognized
     * chrome keep the normal browser menu. skinnycal emits the context only —
     * it does not render the menu.
     */
    contextMenuEnabled: PropTypes.bool,

    /**
     * JSON-serializable description of the most recent recognized right-click,
     * for use in Dash callbacks. Contains `target` ("event" | "date" |
     * "resource", precedence in that order), `calendarId`, `viewType`, the
     * resolved `date` ({start, allDay, timeZone}), `resource`
     * ({id, title, extendedProps}), `event` (snapshot incl. `resourceIds`),
     * `jsEvent` (pointer coordinates + modifier keys), and a monotonically
     * increasing `sequence` so repeated right-clicks at the same location still
     * produce a distinct value. All top-level keys are always present; anything
     * unavailable is null. Typed `any` (not `func`) so
     * dash-generate-components exposes it as a Dash prop. See README for the
     * slot-start / timezone caveats.
     */
    contextMenu: PropTypes.any,

    /**
     * An object specifying a command to execute on the calendar API. Each type
     * maps 1:1 to a real FullCalendar API method. Supported:
     * {'type': 'next' | 'prev' | 'today'} to navigate;
     * {'type': 'changeView', 'view': '<name>'} to switch view;
     * {'type': 'setResources', 'id': '<id>', 'resourceIds': ['<id>', ...]}
     *   to move an event between resources (EventApi.setResources);
     * {'type': 'setDates', 'id': '<id>', 'start': ISO, 'end'?: ISO}
     *   to reschedule an event (EventApi.setDates);
     * {'type': 'setProps', 'updates': [{'id': '<id>', 'title'?: '<str>',
     *   'extendedProps'?: {<key>: <val>, ...}}, ...]} to update existing
     *   events' title / extendedProps in place (EventApi.setProp /
     *   setExtendedProp) WITHOUT replacing the whole `events` prop — which
     *   would remount every block. The single-event shorthand
     *   {'type': 'setProps', 'id': '<id>', 'title'?, 'extendedProps'?} is
     *   also accepted (symmetry with setDates). Missing ids are skipped
     *   silently; any `eventDataAttributes` data-* mirrors are refreshed on
     *   the updated block(s).
     * {'type': 'revert'} to undo the most recent drag/resize (info.revert()).
     * Include a nonce/counter so repeated commands change by reference.
     */
    command: PropTypes.object,

    /* Dash glue - output props for callbacks */
    /**
     * The date string of the clicked date, for use in Dash callbacks.
     */
    dateClick: PropTypes.any,
    /**
     * Object containing the selected range information, for use in Dash callbacks.
     */
    select: PropTypes.any,
    /**
     * Flag indicating unselection occurred, for use in Dash callbacks.
     */
    unselect: PropTypes.any,
    /**
     * Object containing information about the clicked event, for use in Dash callbacks.
     */
    eventClick: PropTypes.any,
    /**
     * Object containing information about the dropped event, for use in Dash callbacks.
     */
    eventDrop: PropTypes.any,
    /**
     * Object containing information about the resized event, for use in Dash callbacks.
     */
    eventResize: PropTypes.any,
    /**
     * Object containing information about the added event, for use in Dash callbacks.
     */
    eventAdd: PropTypes.any,
    /**
     * Object containing information about the changed event, for use in Dash callbacks.
     */
    eventChange: PropTypes.any,
    /**
     * Object containing information about the removed event, for use in Dash callbacks.
     */
    eventRemove: PropTypes.any,
    /**
     * Object containing the current date range, for use in Dash callbacks.
     */
    datesSet: PropTypes.any,
    /**
     * Array of current event objects in the calendar, for use in Dash callbacks.
     */
    eventsSet: PropTypes.any,
    /**
     * Dash-assigned callback that should be called to report property changes to Dash, registered automatically.
     */
    setProps: PropTypes.func
};

export default DashFullCalendar;