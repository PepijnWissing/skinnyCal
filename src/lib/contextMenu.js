/**
 * Pure hit-resolution helpers for the `contextMenu` bridge.
 *
 * These live outside the React component on purpose: they take plain values
 * (an element/candidate list, a FullCalendar CalendarApi, a WeakMap of mounted
 * event elements) and return plain JSON, so they can be unit-tested without
 * mounting the calendar or relying on JSDOM's incomplete `elementsFromPoint`.
 *
 * FullCalendar (v6) does not expose a documented right-click callback, and it
 * does not surface its private hit-testing (snap duration, named-timezone
 * offsets) through CalendarApi. So resolution here is DOM-attribute based:
 * FullCalendar's built-in views stamp `data-date` / `data-time` on slot lanes
 * and columns, `data-resource-id` on resource lanes/labels, and skinnycal's own
 * mount hook stamps `data-event-id` on event blocks. See the handover /
 * README caveats: the returned date is the *rendered slot start*, not a
 * sub-slot position, and a named timezone is supplied separately via `timeZone`
 * rather than baked into the string.
 */

/**
 * `element.closest(selector)`, but only accepts a match that is still inside
 * `root` — so a candidate belonging to another calendar on the same page can
 * never resolve against this calendar's root.
 */
export const closestWithinRoot = (element, selector, root) => {
    if (!element || typeof element.closest !== 'function' || !root) {
        return null;
    }
    const match = element.closest(selector);
    if (match && root.contains(match)) {
        return match;
    }
    return null;
};

/**
 * Build the ordered candidate element list for a contextmenu event, restricted
 * to `root`. Combines the event's own composedPath (the DOM ancestry of the
 * clicked node) with the browser's `elementsFromPoint` stack — the latter
 * matters in TimeGrid and Timeline, where FullCalendar draws the resource /
 * date / time layers as overlapping siblings rather than one nested cell, so a
 * clicked resource lane and the underlying date slat are only both reachable
 * via the point stack. Order is preserved (topmost / nearest first).
 */
export const gatherCandidates = (root, jsEvent, doc) => {
    if (!root || !jsEvent) {
        return [];
    }
    const directPath =
        typeof jsEvent.composedPath === 'function'
            ? jsEvent.composedPath()
            : [jsEvent.target];
    const ownerDoc = doc || (root.ownerDocument) || null;
    const pointStack =
        ownerDoc && typeof ownerDoc.elementsFromPoint === 'function'
            ? ownerDoc.elementsFromPoint(jsEvent.clientX, jsEvent.clientY)
            : [];
    const seen = new Set();
    const candidates = [];
    [...directPath, ...pointStack].forEach((el) => {
        // `instanceof Element` isn't reliable across the pure-test boundary, so
        // duck-type on nodeType (1 === ELEMENT_NODE) and closest support.
        const isElement =
            el && el.nodeType === 1 && typeof el.closest === 'function';
        if (isElement && root.contains(el) && !seen.has(el)) {
            seen.add(el);
            candidates.push(el);
        }
    });
    return candidates;
};

/**
 * JSON-safe pointer snapshot: coordinates (both client- and page-relative so a
 * Dash menu can be placed with either) plus modifier keys and the button. We
 * deliberately do NOT gate on `button === 2`: macOS control-click and some
 * assistive devices emit a `contextmenu` event with a different button value,
 * and the event type itself is the signal.
 */
export const serializeJsEvent = (jsEvent) => {
    if (!jsEvent) {
        return null;
    }
    return {
        clientX: jsEvent.clientX,
        clientY: jsEvent.clientY,
        pageX: jsEvent.pageX,
        pageY: jsEvent.pageY,
        button: jsEvent.button,
        altKey: Boolean(jsEvent.altKey),
        ctrlKey: Boolean(jsEvent.ctrlKey),
        metaKey: Boolean(jsEvent.metaKey),
        shiftKey: Boolean(jsEvent.shiftKey)
    };
};

/**
 * Plain-JSON snapshot of a FullCalendar ResourceApi.
 */
export const serializeResource = (resource) => {
    if (!resource) {
        return null;
    }
    return {
        id: resource.id,
        title: resource.title,
        extendedProps: resource.extendedProps || {}
    };
};

/**
 * Plain-JSON snapshot of a FullCalendar EventApi for the context payload. Kept
 * separate from the component's own `serializeEvent` on purpose: this one adds
 * `resourceIds`, and folding that into the shared helper would silently change
 * the existing `eventDrop` / `eventChange` / `eventsSet` payloads.
 */
export const serializeContextEvent = (event) => {
    if (!event) {
        return null;
    }
    // EventApi.getResources is always present as a method, but its body only
    // works when the resource plugin is registered — in a free (non-resource)
    // calendar it throws ("Cannot read properties of undefined"). So a plain
    // `typeof === 'function'` guard isn't enough; swallow the throw and report
    // no resources.
    let resourceIds = [];
    if (typeof event.getResources === 'function') {
        try {
            resourceIds = event.getResources().map((resource) => resource.id);
        } catch (e) {
            resourceIds = [];
        }
    }
    return {
        id: event.id,
        groupId: event.groupId,
        title: event.title,
        start: event.startStr,
        end: event.endStr,
        allDay: event.allDay,
        display: event.display,
        extendedProps: event.extendedProps,
        resourceIds
    };
};

/**
 * Resolve the nearest foreground event under the pointer. Prefers the live
 * EventApi via the stamped `data-event-id` (FullCalendar's `eventDidMount`
 * fires only at mount, so the WeakMap could hold a stale EventApi after the
 * event's data changed); falls back to the WeakMap for anonymous events with no
 * public id. Returns the serialized event or null.
 */
export const resolveEventContext = (candidates, api, mountedEvents, root) => {
    for (const candidate of candidates) {
        const eventEl = closestWithinRoot(candidate, '.fc-event', root);
        if (!eventEl) {
            continue;
        }
        const id = eventEl.getAttribute('data-event-id');
        let event = null;
        if (id && api && typeof api.getEventById === 'function') {
            event = api.getEventById(id);
        }
        if (!event && mountedEvents && typeof mountedEvents.get === 'function') {
            event = mountedEvents.get(eventEl);
        }
        if (event) {
            return serializeContextEvent(event);
        }
    }
    return null;
};

/**
 * Resolve the resource lane / label under the pointer via `data-resource-id`,
 * looking the current object up through the CalendarApi. Falls back to an
 * id-only snapshot if the resource can't be resolved (e.g. mid-virtualization).
 * Returns the serialized resource or null.
 */
export const resolveResourceContext = (candidates, api, root) => {
    for (const candidate of candidates) {
        const resourceEl = closestWithinRoot(
            candidate,
            '[data-resource-id]',
            root
        );
        if (!resourceEl) {
            continue;
        }
        const resourceId = resourceEl.getAttribute('data-resource-id');
        if (!resourceId) {
            continue;
        }
        const resource =
            api && typeof api.getResourceById === 'function'
                ? api.getResourceById(resourceId)
                : null;
        return (
            serializeResource(resource) || {
                id: resourceId,
                title: null,
                extendedProps: {}
            }
        );
    }
    return null;
};

/**
 * Resolve the rendered date/time slot under the pointer. `data-date` and
 * `data-time` may live on different overlapping elements (a date column and a
 * horizontal slat in TimeGrid), so each is searched across the whole candidate
 * list independently and then combined:
 *   - a `data-date` already carrying a time ("...T..")  -> timed, use as-is
 *   - `data-date` (date only) + a separate `data-time`  -> timed, joined
 *   - `data-date` alone                                 -> all-day
 * Returns {start, allDay} or null.
 */
export const resolveDateContext = (candidates, root) => {
    let dateValue = null;
    let timeValue = null;
    for (const candidate of candidates) {
        if (dateValue === null) {
            const dateEl = closestWithinRoot(candidate, '[data-date]', root);
            if (dateEl) {
                dateValue = dateEl.getAttribute('data-date');
            }
        }
        if (timeValue === null) {
            const timeEl = closestWithinRoot(candidate, '[data-time]', root);
            if (timeEl) {
                timeValue = timeEl.getAttribute('data-time');
            }
        }
        if (dateValue !== null && timeValue !== null) {
            break;
        }
    }

    if (!dateValue) {
        return null;
    }

    let start;
    let allDay;
    if (dateValue.includes('T')) {
        start = dateValue;
        allDay = false;
    } else if (timeValue) {
        start = `${dateValue}T${timeValue}`;
        allDay = false;
    } else {
        start = dateValue;
        allDay = true;
    }
    return {start, allDay};
};

/**
 * Core resolution: turn a candidate element list + CalendarApi into a
 * context-menu payload, or null if nothing recognizable was under the pointer.
 *
 * Target precedence is event -> date -> resource, but the payload always
 * carries every context that could be resolved (so an event target still
 * reports its underlying date and resource when available). This is the pure
 * counterpart of `buildContextMenuPayload` and takes an explicit candidate
 * list, which is what the unit tests exercise.
 */
export const resolveContextMenu = ({
    candidates,
    api,
    jsEvent,
    mountedEvents,
    calendarId,
    sequence,
    root
}) => {
    const event = resolveEventContext(candidates, api, mountedEvents, root);
    const date = resolveDateContext(candidates, root);
    const resource = resolveResourceContext(candidates, api, root);

    let target = null;
    if (event) {
        target = 'event';
    } else if (date) {
        target = 'date';
    } else if (resource) {
        target = 'resource';
    }

    if (!target) {
        return null;
    }

    const timeZone =
        (api && typeof api.getOption === 'function' && api.getOption('timeZone')) ||
        'local';
    const viewType =
        api && typeof api.view === 'object' && api.view ? api.view.type : null;

    return {
        sequence,
        target,
        calendarId: calendarId || null,
        viewType,
        date: date ? {start: date.start, allDay: date.allDay, timeZone} : null,
        resource: resource || null,
        event: event || null,
        jsEvent: serializeJsEvent(jsEvent)
    };
};

/**
 * DOM-facing entry point used by the React component: gathers the candidate
 * element stack from the event and delegates to `resolveContextMenu`.
 */
export const buildContextMenuPayload = ({
    root,
    api,
    jsEvent,
    mountedEvents,
    calendarId,
    sequence,
    doc
}) => {
    if (!root || !jsEvent) {
        return null;
    }
    const candidates = gatherCandidates(root, jsEvent, doc);
    return resolveContextMenu({
        candidates,
        api,
        jsEvent,
        mountedEvents,
        calendarId,
        sequence,
        root
    });
};
