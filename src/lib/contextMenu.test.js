import {
    gatherCandidates,
    serializeJsEvent,
    serializeResource,
    serializeContextEvent,
    resolveContextMenu,
    buildContextMenuPayload
} from './contextMenu';

/* ------------------------------------------------------------------ *
 * Minimal fake DOM. The hit-resolution helpers only ever touch
 * `.closest(selector)`, `.getAttribute(name)`, `.nodeType`, and
 * `root.contains(el)`, so we model exactly that — no JSDOM needed, which
 * is the whole point of keeping resolution in pure functions.
 * ------------------------------------------------------------------ */

const matchesSelector = (node, selector) => {
    if (selector.startsWith('.')) {
        return node._classes.includes(selector.slice(1));
    }
    const attr = selector.match(/^\[([^\]]+)\]$/);
    if (attr) {
        return Object.prototype.hasOwnProperty.call(node._attrs, attr[1]);
    }
    return false;
};

const makeRoot = () => {
    const members = new Set();
    const root = {
        nodeType: 1,
        contains: (el) => members.has(el),
        // Create an element that belongs to this root's subtree.
        el: ({classes = [], attrs = {}, parent = null} = {}) => {
            const node = {
                nodeType: 1,
                _classes: classes,
                _attrs: attrs,
                parent,
                getAttribute(name) {
                    return Object.prototype.hasOwnProperty.call(
                        this._attrs,
                        name
                    )
                        ? this._attrs[name]
                        : null;
                },
                closest(selector) {
                    let cur = this;
                    while (cur) {
                        if (matchesSelector(cur, selector)) {
                            return cur;
                        }
                        cur = cur.parent;
                    }
                    return null;
                }
            };
            members.add(node);
            return node;
        }
    };
    return root;
};

const makeEventApi = (overrides = {}) => ({
    id: 'ev-1',
    groupId: '',
    title: 'Module A',
    startStr: '2026-08-19',
    endStr: '2026-08-20',
    allDay: true,
    display: 'auto',
    extendedProps: {courseCode: 'ABC'},
    getResources: () => [{id: 'course-42'}],
    ...overrides
});

const makeResourceApi = (overrides = {}) => ({
    id: 'course-42',
    title: 'Course 42',
    extendedProps: {room: 'B1'},
    ...overrides
});

const makeApi = ({events = {}, resources = {}, timeZone, viewType} = {}) => ({
    getEventById: (id) => events[id] || null,
    getResourceById: (id) => resources[id] || null,
    getOption: (key) => (key === 'timeZone' ? timeZone : undefined),
    view: {type: viewType || 'dayGridMonth'}
});

const jsEventStub = (overrides = {}) => ({
    clientX: 812,
    clientY: 376,
    pageX: 812,
    pageY: 541,
    button: 2,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides
});

/* ------------------------------------------------------------------ */

describe('serializeJsEvent', () => {
    test('captures all four coordinates and every modifier key', () => {
        const out = serializeJsEvent(
            jsEventStub({
                altKey: true,
                ctrlKey: true,
                metaKey: false,
                shiftKey: true
            })
        );
        expect(out).toEqual({
            clientX: 812,
            clientY: 376,
            pageX: 812,
            pageY: 541,
            button: 2,
            altKey: true,
            ctrlKey: true,
            metaKey: false,
            shiftKey: true
        });
    });

    test('returns null for a missing event', () => {
        expect(serializeJsEvent(null)).toBeNull();
    });
});

describe('serializeResource / serializeContextEvent', () => {
    test('resource snapshot is plain JSON with an extendedProps fallback', () => {
        expect(serializeResource(makeResourceApi({extendedProps: undefined}))).toEqual(
            {id: 'course-42', title: 'Course 42', extendedProps: {}}
        );
    });

    test('event snapshot includes resourceIds from getResources', () => {
        expect(serializeContextEvent(makeEventApi())).toEqual({
            id: 'ev-1',
            groupId: '',
            title: 'Module A',
            start: '2026-08-19',
            end: '2026-08-20',
            allDay: true,
            display: 'auto',
            extendedProps: {courseCode: 'ABC'},
            resourceIds: ['course-42']
        });
    });

    test('event snapshot tolerates an EventApi without getResources', () => {
        const ev = makeEventApi({getResources: undefined});
        expect(serializeContextEvent(ev).resourceIds).toEqual([]);
    });

    test('event snapshot swallows a getResources that throws (no resource plugin)', () => {
        // In a free (non-resource) calendar EventApi.getResources exists but
        // throws when called. resourceIds must degrade to [] rather than
        // blowing up the whole payload.
        const ev = makeEventApi({
            getResources: () => {
                throw new TypeError('resource plugin not loaded');
            }
        });
        expect(serializeContextEvent(ev).resourceIds).toEqual([]);
    });
});

describe('resolveContextMenu — event target', () => {
    test('resolves a live event via data-event-id / getEventById', () => {
        const root = makeRoot();
        const eventEl = root.el({
            classes: ['fc-event'],
            attrs: {'data-event-id': 'ev-1'}
        });
        const live = makeEventApi({title: 'Live title'});
        const api = makeApi({events: {'ev-1': live}});

        const payload = resolveContextMenu({
            candidates: [eventEl],
            api,
            jsEvent: jsEventStub(),
            mountedEvents: new WeakMap(),
            calendarId: 'cal',
            sequence: 1,
            root
        });

        expect(payload.target).toBe('event');
        expect(payload.event.title).toBe('Live title');
        expect(payload.calendarId).toBe('cal');
    });

    test('falls back to the WeakMap for an anonymous event', () => {
        const root = makeRoot();
        const eventEl = root.el({classes: ['fc-event']}); // no data-event-id
        const mounted = new WeakMap();
        mounted.set(eventEl, makeEventApi({id: '', title: 'Anon'}));
        const api = makeApi();

        const payload = resolveContextMenu({
            candidates: [eventEl],
            api,
            jsEvent: jsEventStub(),
            mountedEvents: mounted,
            calendarId: 'cal',
            sequence: 1,
            root
        });

        expect(payload.target).toBe('event');
        expect(payload.event.title).toBe('Anon');
    });

    test('prefers the live EventApi over the mounted fallback', () => {
        const root = makeRoot();
        const eventEl = root.el({
            classes: ['fc-event'],
            attrs: {'data-event-id': 'ev-1'}
        });
        const mounted = new WeakMap();
        mounted.set(eventEl, makeEventApi({title: 'Stale'}));
        const api = makeApi({events: {'ev-1': makeEventApi({title: 'Fresh'})}});

        const payload = resolveContextMenu({
            candidates: [eventEl],
            api,
            jsEvent: jsEventStub(),
            mountedEvents: mounted,
            calendarId: 'cal',
            sequence: 1,
            root
        });

        expect(payload.event.title).toBe('Fresh');
    });

    test('event target still reports underlying date and resource', () => {
        const root = makeRoot();
        const lane = root.el({attrs: {'data-resource-id': 'course-42'}});
        const slat = root.el({attrs: {'data-date': '2026-08-19'}, parent: lane});
        const eventEl = root.el({
            classes: ['fc-event'],
            attrs: {'data-event-id': 'ev-1'},
            parent: slat
        });
        const api = makeApi({
            events: {'ev-1': makeEventApi()},
            resources: {'course-42': makeResourceApi()},
            viewType: 'resourceTimeline'
        });

        const payload = resolveContextMenu({
            candidates: [eventEl, slat, lane],
            api,
            jsEvent: jsEventStub(),
            mountedEvents: new WeakMap(),
            calendarId: 'cal',
            sequence: 3,
            root
        });

        expect(payload.target).toBe('event');
        expect(payload.date).toEqual({
            start: '2026-08-19',
            allDay: true,
            timeZone: 'local'
        });
        expect(payload.resource.id).toBe('course-42');
        expect(payload.viewType).toBe('resourceTimeline');
    });
});

describe('resolveContextMenu — date target', () => {
    test('date-only DayGrid cell yields an all-day slot', () => {
        const root = makeRoot();
        const cell = root.el({attrs: {'data-date': '2026-08-19'}});
        const payload = resolveContextMenu({
            candidates: [cell],
            api: makeApi(),
            jsEvent: jsEventStub(),
            mountedEvents: new WeakMap(),
            calendarId: 'cal',
            sequence: 1,
            root
        });
        expect(payload.target).toBe('date');
        expect(payload.date).toEqual({
            start: '2026-08-19',
            allDay: true,
            timeZone: 'local'
        });
    });

    test('date and time from separate TimeGrid layers combine into a timed slot', () => {
        const root = makeRoot();
        // In TimeGrid the day column (data-date) and the horizontal slat
        // (data-time) are overlapping siblings, not nested — both reach the
        // resolver via the point stack.
        const dayCol = root.el({attrs: {'data-date': '2026-08-19'}});
        const slat = root.el({attrs: {'data-time': '09:30:00'}});
        const payload = resolveContextMenu({
            candidates: [slat, dayCol],
            api: makeApi({timeZone: 'America/New_York'}),
            jsEvent: jsEventStub(),
            mountedEvents: new WeakMap(),
            calendarId: 'cal',
            sequence: 1,
            root
        });
        expect(payload.target).toBe('date');
        expect(payload.date).toEqual({
            start: '2026-08-19T09:30:00',
            allDay: false,
            timeZone: 'America/New_York'
        });
    });

    test('a data-date already carrying a time is used as-is', () => {
        const root = makeRoot();
        const cell = root.el({attrs: {'data-date': '2026-08-19T09:30:00'}});
        const payload = resolveContextMenu({
            candidates: [cell],
            api: makeApi(),
            jsEvent: jsEventStub(),
            mountedEvents: new WeakMap(),
            calendarId: 'cal',
            sequence: 1,
            root
        });
        expect(payload.date).toEqual({
            start: '2026-08-19T09:30:00',
            allDay: false,
            timeZone: 'local'
        });
    });

    test('timeline date + resource from overlapping layers', () => {
        const root = makeRoot();
        const lane = root.el({attrs: {'data-resource-id': 'course-42'}});
        const slot = root.el({attrs: {'data-date': '2026-08-19'}});
        const api = makeApi({
            resources: {'course-42': makeResourceApi()},
            viewType: 'resourceTimeline'
        });
        const payload = resolveContextMenu({
            candidates: [slot, lane],
            api,
            jsEvent: jsEventStub(),
            mountedEvents: new WeakMap(),
            calendarId: 'cal',
            sequence: 1,
            root
        });
        expect(payload.target).toBe('date');
        expect(payload.resource.id).toBe('course-42');
        expect(payload.date.start).toBe('2026-08-19');
    });
});

describe('resolveContextMenu — resource target', () => {
    test('resource label with no date resolves as a resource target', () => {
        const root = makeRoot();
        const label = root.el({attrs: {'data-resource-id': 'course-42'}});
        const api = makeApi({resources: {'course-42': makeResourceApi()}});
        const payload = resolveContextMenu({
            candidates: [label],
            api,
            jsEvent: jsEventStub(),
            mountedEvents: new WeakMap(),
            calendarId: 'cal',
            sequence: 1,
            root
        });
        expect(payload.target).toBe('resource');
        expect(payload.date).toBeNull();
        expect(payload.resource).toEqual({
            id: 'course-42',
            title: 'Course 42',
            extendedProps: {room: 'B1'}
        });
    });

    test('unresolvable resource id still emits an id-only snapshot', () => {
        const root = makeRoot();
        const label = root.el({attrs: {'data-resource-id': 'gone'}});
        const payload = resolveContextMenu({
            candidates: [label],
            api: makeApi(), // getResourceById -> null
            jsEvent: jsEventStub(),
            mountedEvents: new WeakMap(),
            calendarId: 'cal',
            sequence: 1,
            root
        });
        expect(payload.resource).toEqual({
            id: 'gone',
            title: null,
            extendedProps: {}
        });
    });
});

describe('resolveContextMenu — precedence & isolation', () => {
    test('precedence is event -> date -> resource', () => {
        const root = makeRoot();
        const lane = root.el({attrs: {'data-resource-id': 'course-42'}});
        const slot = root.el({attrs: {'data-date': '2026-08-19'}, parent: lane});
        const eventEl = root.el({
            classes: ['fc-event'],
            attrs: {'data-event-id': 'ev-1'},
            parent: slot
        });
        const api = makeApi({
            events: {'ev-1': makeEventApi()},
            resources: {'course-42': makeResourceApi()}
        });
        expect(
            resolveContextMenu({
                candidates: [eventEl, slot, lane],
                api,
                jsEvent: jsEventStub(),
                mountedEvents: new WeakMap(),
                calendarId: 'cal',
                sequence: 1,
                root
            }).target
        ).toBe('event');

        // Drop the event candidate -> date wins over resource.
        expect(
            resolveContextMenu({
                candidates: [slot, lane],
                api,
                jsEvent: jsEventStub(),
                mountedEvents: new WeakMap(),
                calendarId: 'cal',
                sequence: 1,
                root
            }).target
        ).toBe('date');
    });

    test('elements from another calendar root are ignored', () => {
        const root = makeRoot();
        const other = makeRoot();
        const foreignEvent = other.el({
            classes: ['fc-event'],
            attrs: {'data-event-id': 'ev-1'}
        });
        const payload = resolveContextMenu({
            candidates: [foreignEvent],
            api: makeApi({events: {'ev-1': makeEventApi()}}),
            jsEvent: jsEventStub(),
            mountedEvents: new WeakMap(),
            calendarId: 'cal',
            sequence: 1,
            root // foreignEvent is NOT contained here
        });
        expect(payload).toBeNull();
    });

    test('unrecognized chrome returns null', () => {
        const root = makeRoot();
        const button = root.el({classes: ['fc-button']});
        const payload = resolveContextMenu({
            candidates: [button],
            api: makeApi(),
            jsEvent: jsEventStub(),
            mountedEvents: new WeakMap(),
            calendarId: 'cal',
            sequence: 1,
            root
        });
        expect(payload).toBeNull();
    });
});

describe('gatherCandidates', () => {
    test('merges composedPath and elementsFromPoint, dedupes, and scopes to root', () => {
        const root = makeRoot();
        const a = root.el({attrs: {'data-date': '2026-08-19'}});
        const b = root.el({attrs: {'data-resource-id': 'course-42'}});
        const foreign = makeRoot().el({classes: ['fc-event']});
        const jsEvent = jsEventStub({
            composedPath: () => [a, foreign],
            target: a
        });
        const doc = {elementsFromPoint: () => [b, a]}; // `a` repeats -> deduped

        const candidates = gatherCandidates(root, jsEvent, doc);
        expect(candidates).toEqual([a, b]);
    });

    test('falls back to jsEvent.target when composedPath is absent', () => {
        const root = makeRoot();
        const a = root.el({attrs: {'data-date': '2026-08-19'}});
        const candidates = gatherCandidates(
            root,
            {target: a, clientX: 0, clientY: 0},
            {}
        );
        expect(candidates).toEqual([a]);
    });
});

describe('buildContextMenuPayload', () => {
    test('gathers candidates then resolves; sequence is echoed verbatim', () => {
        const root = makeRoot();
        const cell = root.el({attrs: {'data-date': '2026-08-19'}});
        const jsEvent = jsEventStub({composedPath: () => [cell]});
        const first = buildContextMenuPayload({
            root,
            api: makeApi(),
            jsEvent,
            mountedEvents: new WeakMap(),
            calendarId: 'cal',
            sequence: 7,
            doc: {}
        });
        const second = buildContextMenuPayload({
            root,
            api: makeApi(),
            jsEvent,
            mountedEvents: new WeakMap(),
            calendarId: 'cal',
            sequence: 8,
            doc: {}
        });
        // Repeated identical right-clicks differ only by the caller's sequence.
        expect(first.sequence).toBe(7);
        expect(second.sequence).toBe(8);
        expect(first.date).toEqual(second.date);
    });

    test('returns null without a root or jsEvent', () => {
        expect(
            buildContextMenuPayload({root: null, jsEvent: jsEventStub()})
        ).toBeNull();
        expect(
            buildContextMenuPayload({root: makeRoot(), jsEvent: null})
        ).toBeNull();
    });
});
