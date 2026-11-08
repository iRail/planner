/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-mixed-operators, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars, default-case, jsdoc/require-param*/
import $protobuf from "protobufjs/minimal.js";

const $Reader = $protobuf.Reader, $util = $protobuf.util;
const $Object = $util.global.Object, $undefined = $util.global.undefined, $Error = $util.global.Error, $RangeError = $util.global.RangeError;

const $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});

export const transit_realtime = $root.transit_realtime = (() => {

    const transit_realtime = {};

    transit_realtime.FeedMessage = (function() {

        const FeedMessage = function (properties) {
            this.entity = [];
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        FeedMessage.prototype.header = null;
        FeedMessage.prototype.entity = $util.emptyArray;

        FeedMessage.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.transit_realtime.FeedMessage();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        message.header = $root.transit_realtime.FeedHeader.decode(reader, reader.size(), $undefined, _depth + 1, message.header);
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if (!(message.entity && message.entity.length))
                            message.entity = [];
                        message.entity.push($root.transit_realtime.FeedEntity.decode(reader, reader.size(), $undefined, _depth + 1));
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            if (!$Object.hasOwnProperty.call(message, "header"))
                throw $util.ProtocolError("missing required 'header'", { instance: message });
            return message;
        };

        FeedMessage.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/transit_realtime.FeedMessage";
        };

        return FeedMessage;
    })();

    transit_realtime.FeedHeader = (function() {

        const FeedHeader = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        FeedHeader.prototype.gtfsRealtimeVersion = "";
        FeedHeader.prototype.timestamp = $util.Long ? $util.Long.fromBits(0,0,true) : 0;

        FeedHeader.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.transit_realtime.FeedHeader();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        message.gtfsRealtimeVersion = reader.string();
                        continue;
                    }
                case 3: {
                        if (wireType !== 0)
                            break;
                        message.timestamp = reader.uint64();
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            if (!$Object.hasOwnProperty.call(message, "gtfsRealtimeVersion"))
                throw $util.ProtocolError("missing required 'gtfsRealtimeVersion'", { instance: message });
            return message;
        };

        FeedHeader.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/transit_realtime.FeedHeader";
        };

        return FeedHeader;
    })();

    transit_realtime.FeedEntity = (function() {

        const FeedEntity = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        FeedEntity.prototype.id = "";
        FeedEntity.prototype.isDeleted = false;
        FeedEntity.prototype.tripUpdate = null;

        FeedEntity.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.transit_realtime.FeedEntity();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        message.id = reader.string();
                        continue;
                    }
                case 2: {
                        if (wireType !== 0)
                            break;
                        message.isDeleted = reader.bool();
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        message.tripUpdate = $root.transit_realtime.TripUpdate.decode(reader, reader.size(), $undefined, _depth + 1, message.tripUpdate);
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            if (!$Object.hasOwnProperty.call(message, "id"))
                throw $util.ProtocolError("missing required 'id'", { instance: message });
            return message;
        };

        FeedEntity.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/transit_realtime.FeedEntity";
        };

        return FeedEntity;
    })();

    transit_realtime.TripUpdate = (function() {

        const TripUpdate = function (properties) {
            this.stopTimeUpdate = [];
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        TripUpdate.prototype.trip = null;
        TripUpdate.prototype.stopTimeUpdate = $util.emptyArray;
        TripUpdate.prototype.timestamp = $util.Long ? $util.Long.fromBits(0,0,true) : 0;
        TripUpdate.prototype.delay = 0;

        TripUpdate.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.transit_realtime.TripUpdate();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        message.trip = $root.transit_realtime.TripDescriptor.decode(reader, reader.size(), $undefined, _depth + 1, message.trip);
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        if (!(message.stopTimeUpdate && message.stopTimeUpdate.length))
                            message.stopTimeUpdate = [];
                        message.stopTimeUpdate.push($root.transit_realtime.TripUpdate.StopTimeUpdate.decode(reader, reader.size(), $undefined, _depth + 1));
                        continue;
                    }
                case 4: {
                        if (wireType !== 0)
                            break;
                        message.timestamp = reader.uint64();
                        continue;
                    }
                case 5: {
                        if (wireType !== 0)
                            break;
                        message.delay = reader.int32();
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            if (!$Object.hasOwnProperty.call(message, "trip"))
                throw $util.ProtocolError("missing required 'trip'", { instance: message });
            return message;
        };

        TripUpdate.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/transit_realtime.TripUpdate";
        };

        TripUpdate.StopTimeEvent = (function() {

            const StopTimeEvent = function (properties) {
                if (properties)
                    for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                        if (properties[keys[i]] != null && keys[i] !== "__proto__")
                            this[keys[i]] = properties[keys[i]];
            };

            StopTimeEvent.prototype.delay = 0;
            StopTimeEvent.prototype.time = $util.Long ? $util.Long.fromBits(0,0,false) : 0;
            StopTimeEvent.prototype.uncertainty = 0;

            StopTimeEvent.decode = function (reader, length, _end, _depth, _target) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (_depth === $undefined)
                    _depth = 0;
                if (_depth > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                let end, message;
                if (length === $undefined)
                    end = reader.len;
                else {
                    end = reader.pos + length;
                    if (end > reader.len)
                        throw $RangeError("index out of range");
                    length = reader.len;
                    reader.len = end;
                }
                message = _target || new $root.transit_realtime.TripUpdate.StopTimeEvent();
                while (reader.pos < end) {
                    let start = reader.pos;
                    let tag = reader.tag();
                    if (tag === _end) {
                        _end = $undefined;
                        break;
                    }
                    let wireType = tag & 7;
                    switch (tag >>>= 3) {
                    case 1: {
                            if (wireType !== 0)
                                break;
                            message.delay = reader.int32();
                            continue;
                        }
                    case 2: {
                            if (wireType !== 0)
                                break;
                            message.time = reader.int64();
                            continue;
                        }
                    case 3: {
                            if (wireType !== 0)
                                break;
                            message.uncertainty = reader.int32();
                            continue;
                        }
                    }
                    reader.skipType(wireType, _depth, tag);
                    if (!reader.discardUnknown) {
                        $util.makeProp(message, "$unknowns", false);
                        (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                    }
                }
                if (length !== $undefined) {
                    if (reader.pos !== end)
                        throw $RangeError("index out of range");
                    reader.len = length;
                }
                if (_end !== $undefined)
                    throw $Error("missing end group");
                return message;
            };

            StopTimeEvent.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/transit_realtime.TripUpdate.StopTimeEvent";
            };

            return StopTimeEvent;
        })();

        TripUpdate.StopTimeUpdate = (function() {

            const StopTimeUpdate = function (properties) {
                if (properties)
                    for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                        if (properties[keys[i]] != null && keys[i] !== "__proto__")
                            this[keys[i]] = properties[keys[i]];
            };

            StopTimeUpdate.prototype.stopSequence = 0;
            StopTimeUpdate.prototype.stopId = "";
            StopTimeUpdate.prototype.arrival = null;
            StopTimeUpdate.prototype.departure = null;
            StopTimeUpdate.prototype.scheduleRelationship = 0;

            StopTimeUpdate.decode = function (reader, length, _end, _depth, _target) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                if (_depth === $undefined)
                    _depth = 0;
                if (_depth > $Reader.recursionLimit)
                    throw $Error("max depth exceeded");
                let end, message, value;
                if (length === $undefined)
                    end = reader.len;
                else {
                    end = reader.pos + length;
                    if (end > reader.len)
                        throw $RangeError("index out of range");
                    length = reader.len;
                    reader.len = end;
                }
                message = _target || new $root.transit_realtime.TripUpdate.StopTimeUpdate();
                while (reader.pos < end) {
                    let start = reader.pos;
                    let tag = reader.tag();
                    if (tag === _end) {
                        _end = $undefined;
                        break;
                    }
                    let wireType = tag & 7;
                    switch (tag >>>= 3) {
                    case 1: {
                            if (wireType !== 0)
                                break;
                            message.stopSequence = reader.uint32();
                            continue;
                        }
                    case 4: {
                            if (wireType !== 2)
                                break;
                            message.stopId = reader.string();
                            continue;
                        }
                    case 2: {
                            if (wireType !== 2)
                                break;
                            message.arrival = $root.transit_realtime.TripUpdate.StopTimeEvent.decode(reader, reader.size(), $undefined, _depth + 1, message.arrival);
                            continue;
                        }
                    case 3: {
                            if (wireType !== 2)
                                break;
                            message.departure = $root.transit_realtime.TripUpdate.StopTimeEvent.decode(reader, reader.size(), $undefined, _depth + 1, message.departure);
                            continue;
                        }
                    case 5: {
                            if (wireType !== 0)
                                break;
                            value = reader.int32();
                            if ($root.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship[value] !== $undefined)
                                message.scheduleRelationship = value;
                            else if (!reader.discardUnknown) {
                                $util.makeProp(message, "$unknowns", false);
                                (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                            }
                            continue;
                        }
                    }
                    reader.skipType(wireType, _depth, tag);
                    if (!reader.discardUnknown) {
                        $util.makeProp(message, "$unknowns", false);
                        (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                    }
                }
                if (length !== $undefined) {
                    if (reader.pos !== end)
                        throw $RangeError("index out of range");
                    reader.len = length;
                }
                if (_end !== $undefined)
                    throw $Error("missing end group");
                return message;
            };

            StopTimeUpdate.getTypeUrl = function(prefix) {
                if (prefix === $undefined)
                    prefix = "type.googleapis.com";
                return prefix + "/transit_realtime.TripUpdate.StopTimeUpdate";
            };

            StopTimeUpdate.ScheduleRelationship = (function() {
                const valuesById = $Object.create(null), values = $Object.create(valuesById);
                values[valuesById[0] = "SCHEDULED"] = 0;
                values[valuesById[1] = "SKIPPED"] = 1;
                values[valuesById[2] = "NO_DATA"] = 2;
                values[valuesById[3] = "UNSCHEDULED"] = 3;
                return values;
            })();

            return StopTimeUpdate;
        })();

        return TripUpdate;
    })();

    transit_realtime.TripDescriptor = (function() {

        const TripDescriptor = function (properties) {
            if (properties)
                for (let keys = $Object.keys(properties), i = 0; i < keys.length; ++i)
                    if (properties[keys[i]] != null && keys[i] !== "__proto__")
                        this[keys[i]] = properties[keys[i]];
        };

        TripDescriptor.prototype.tripId = "";
        TripDescriptor.prototype.routeId = "";
        TripDescriptor.prototype.directionId = 0;
        TripDescriptor.prototype.startTime = "";
        TripDescriptor.prototype.startDate = "";
        TripDescriptor.prototype.scheduleRelationship = 0;

        TripDescriptor.decode = function (reader, length, _end, _depth, _target) {
            if (!(reader instanceof $Reader))
                reader = $Reader.create(reader);
            if (_depth === $undefined)
                _depth = 0;
            if (_depth > $Reader.recursionLimit)
                throw $Error("max depth exceeded");
            let end, message, value;
            if (length === $undefined)
                end = reader.len;
            else {
                end = reader.pos + length;
                if (end > reader.len)
                    throw $RangeError("index out of range");
                length = reader.len;
                reader.len = end;
            }
            message = _target || new $root.transit_realtime.TripDescriptor();
            while (reader.pos < end) {
                let start = reader.pos;
                let tag = reader.tag();
                if (tag === _end) {
                    _end = $undefined;
                    break;
                }
                let wireType = tag & 7;
                switch (tag >>>= 3) {
                case 1: {
                        if (wireType !== 2)
                            break;
                        message.tripId = reader.string();
                        continue;
                    }
                case 5: {
                        if (wireType !== 2)
                            break;
                        message.routeId = reader.string();
                        continue;
                    }
                case 6: {
                        if (wireType !== 0)
                            break;
                        message.directionId = reader.uint32();
                        continue;
                    }
                case 2: {
                        if (wireType !== 2)
                            break;
                        message.startTime = reader.string();
                        continue;
                    }
                case 3: {
                        if (wireType !== 2)
                            break;
                        message.startDate = reader.string();
                        continue;
                    }
                case 4: {
                        if (wireType !== 0)
                            break;
                        value = reader.int32();
                        if ($root.transit_realtime.TripDescriptor.ScheduleRelationship[value] !== $undefined)
                            message.scheduleRelationship = value;
                        else if (!reader.discardUnknown) {
                            $util.makeProp(message, "$unknowns", false);
                            (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                        }
                        continue;
                    }
                }
                reader.skipType(wireType, _depth, tag);
                if (!reader.discardUnknown) {
                    $util.makeProp(message, "$unknowns", false);
                    (message.$unknowns || (message.$unknowns = [])).push(reader.raw(start, reader.pos));
                }
            }
            if (length !== $undefined) {
                if (reader.pos !== end)
                    throw $RangeError("index out of range");
                reader.len = length;
            }
            if (_end !== $undefined)
                throw $Error("missing end group");
            return message;
        };

        TripDescriptor.getTypeUrl = function(prefix) {
            if (prefix === $undefined)
                prefix = "type.googleapis.com";
            return prefix + "/transit_realtime.TripDescriptor";
        };

        TripDescriptor.ScheduleRelationship = (function() {
            const valuesById = $Object.create(null), values = $Object.create(valuesById);
            values[valuesById[0] = "SCHEDULED"] = 0;
            values[valuesById[1] = "ADDED"] = 1;
            values[valuesById[2] = "UNSCHEDULED"] = 2;
            values[valuesById[3] = "CANCELED"] = 3;
            values[valuesById[5] = "REPLACEMENT"] = 5;
            values[valuesById[6] = "DUPLICATED"] = 6;
            values[valuesById[7] = "DELETED"] = 7;
            return values;
        })();

        return TripDescriptor;
    })();

    return transit_realtime;
})();

export {
  $root as default
};
