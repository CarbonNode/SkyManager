#include "dossier_store.h"
#ifndef DOSSIER_STORE_TEST
#include "actor_identity.h"
#endif
#include <algorithm>
#include <chrono>
#include <cctype>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <set>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace DossierStore
{
using json = nlohmann::json;
namespace
{
    constexpr std::size_t MaxPeople = 2000, MaxRelations = 10000, MaxHistory = 5000;
    constexpr std::uintmax_t MaxBytes = 16 * 1024 * 1024;
    const std::filesystem::path StorePath("Data/SKSE/Plugins/HotkeyDeck/dossier.json");
    using IdentityResolver = std::function<json(const json&)>;

    std::string Text(const json& value, std::size_t limit, bool required = true, bool multiline = false)
    {
        if (!value.is_string()) throw std::runtime_error("A text field has an invalid value.");
        auto s = value.get<std::string>();
        if (s.size() > limit) throw std::runtime_error("That text is too long.");
        s.erase(std::remove_if(s.begin(), s.end(), [multiline](unsigned char c) {
            return (c < 32 && !(multiline && (c == '\n' || c == '\t'))) || c == 127;
        }), s.end());
        const auto start = s.find_first_not_of(" \t\r\n");
        const auto end = s.find_last_not_of(" \t\r\n");
        s = start == std::string::npos ? std::string() : s.substr(start, end - start + 1);
        if (required && s.empty()) throw std::runtime_error("Fill in the required text first.");
        return s;
    }
    std::string Lower(std::string s)
    {
        std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return s;
    }
    std::string Stamp()
    {
        const auto time = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
        std::tm tm{};
#ifdef _WIN32
        gmtime_s(&tm, &time);
#else
        gmtime_r(&time, &tm);
#endif
        std::ostringstream out; out << std::put_time(&tm, "%Y-%m-%dT%H:%M:%SZ"); return out.str();
    }
    std::string NewId(const char* prefix)
    {
        static std::uint64_t sequence = 0;
        return std::string(prefix) + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()) + "-" + std::to_string(++sequence);
    }
    json Empty()
    {
        return {{"version", 1}, {"people", json::array()}, {"relations", json::array()}, {"history", json::array()}};
    }
    void Validate(const json& data)
    {
        if (!data.is_object()) throw std::runtime_error("The dossier library is damaged; it has been left untouched.");
        for (const auto key : {"people", "relations", "history"}) {
            if (!data.contains(key) || !data[key].is_array()) throw std::runtime_error("The dossier library is incomplete; it has been left untouched.");
            for (const auto& row : data[key]) {
                if (!row.is_object() || !row.contains("id") || !row["id"].is_string())
                    throw std::runtime_error("The dossier library contains an invalid row; it has been left untouched.");
            }
        }
        if (data["people"].size() > MaxPeople || data["relations"].size() > MaxRelations || data["history"].size() > MaxHistory)
            throw std::runtime_error("The dossier library exceeds its supported size; it has been left untouched.");
    }
    json Read()
    {
        if (!std::filesystem::exists(StorePath)) return Empty();
        if (std::filesystem::file_size(StorePath) > MaxBytes) throw std::runtime_error("The dossier library is too large to read safely.");
        std::ifstream in(StorePath, std::ios::binary);
        auto data = json::parse(in, nullptr, false); Validate(data); return data;
    }
    void WriteFile(const std::filesystem::path& path, const json& data)
    {
        const auto bytes = data.dump(2, ' ', false, json::error_handler_t::replace);
        if (bytes.size() > MaxBytes) throw std::runtime_error("The dossier library is full. Remove unused notes before saving more.");
        std::filesystem::create_directories(path.parent_path());
        auto temporary = path; temporary += ".tmp";
        {
            std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
            out << bytes; out.flush();
            if (!out) throw std::runtime_error("The dossier could not be saved. Your previous file is unchanged.");
        }
#ifdef _WIN32
        if (!MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("The dossier file could not be replaced. Your previous file is unchanged.");
#else
        std::filesystem::rename(temporary, path);
#endif
    }
    void Write(const json& data) { WriteFile(StorePath, data); }
    bool SameActor(const json& a, const json& b)
    {
        return a.is_object() && b.is_object() && a.contains("formId") && a.contains("plugin") &&
            Lower(a.value("formId", std::string())) == Lower(b.value("formId", std::string())) &&
            Lower(a.value("plugin", std::string())) == Lower(b.value("plugin", std::string()));
    }
    json* FindPerson(json& data, const std::string& id)
    {
        for (auto& p : data["people"]) if (p.value("id", std::string()) == id) return &p;
        return nullptr;
    }
    json& Person(json& data, const std::string& id)
    {
        if (auto* p = FindPerson(data, id)) return *p;
        throw std::runtime_error("That person no longer exists in the dossier library.");
    }
    json* FindActor(json& data, const json& actor)
    {
        for (auto& p : data["people"]) if (p.contains("actor") && SameActor(p["actor"], actor)) return &p;
        return nullptr;
    }
    void Event(json& data, const json& personIds, const std::string& type, const std::string& text)
    {
        auto& events = data["history"];
        // User notes are never aged out by automatic preference/relationship events.
        if (events.size() >= MaxHistory) {
            auto old = std::find_if(events.begin(), events.end(), [](const json& event) { return event.value("type", std::string()) != "note"; });
            if (old == events.end()) throw std::runtime_error("Your history is full. Remove a note before adding more.");
            events.erase(old);
        }
        events.push_back({{"id", NewId("event-")}, {"personIds", personIds}, {"type", type}, {"text", text}, {"createdAt", Stamp()}});
    }
    bool Parent(const std::string& kind) { return kind == "parent" || kind == "adoptive-parent"; }
    bool Descends(const json& data, const std::string& from, const std::string& target)
    {
        std::set<std::string> seen; std::vector<std::string> pending{from};
        while (!pending.empty()) {
            const auto id = pending.back(); pending.pop_back();
            if (id == target) return true;
            if (!seen.insert(id).second) continue;
            for (const auto& link : data["relations"])
                if (Parent(link.value("kind", std::string())) && link.value("from", std::string()) == id)
                    pending.push_back(link.value("to", std::string()));
        }
        return false;
    }
    std::string PortraitPath(const json& value)
    {
        auto s = Text(value, 512, false);
        if (s.empty()) return s;
        std::replace(s.begin(), s.end(), '\\', '/');
        const auto lower = Lower(s);
        if ((lower.rfind("portraits/", 0) != 0 && lower.rfind("icons/npcs/", 0) != 0) ||
            s.find("..") != std::string::npos || s.find(':') != std::string::npos || s.find('?') != std::string::npos || s.find('#') != std::string::npos || s.find('%') != std::string::npos)
            throw std::runtime_error("Choose an image from the portrait gallery.");
        const auto dot = lower.find_last_of('.');
        const auto extension = dot == std::string::npos ? std::string() : lower.substr(dot);
        if (extension != ".png" && extension != ".jpg" && extension != ".jpeg" && extension != ".webp")
            throw std::runtime_error("Choose a PNG, JPG or WebP portrait.");
        return s;
    }
    // Mutates a disposable copy only. Handle writes it after every check succeeds.
    // Kept engine-independent so tests exercise the real graph and preference rules.
    bool Apply(json& data, const json& request, const IdentityResolver& resolve, json& reply)
    {
        const auto op = Text(request.value("op", json("list")), 32);
        reply["op"] = op;
        if (op == "resolveActor") {
            const auto actor = resolve(request.at("actor"));
            reply["formId"] = actor.at("runtimeFormId");
            return false;
        }
        if (op == "list" || op == "read") {
            if (request.contains("personId")) reply["personId"] = Person(data, Text(request["personId"], 160))["id"];
            else if (request.contains("actor")) {
                auto actor = resolve(request["actor"]);
                if (auto* person = FindActor(data, actor)) reply["personId"] = (*person)["id"];
            }
            return false;
        }
        if (op == "ensure") {
            json actor;
            if (request.contains("actor")) {
                actor = resolve(request["actor"]);
                if (auto* p = FindActor(data, actor)) { reply["personId"] = (*p)["id"]; return false; }
            }
            const auto name = Text(request.value("name", actor.is_object() ? actor.value("name", json("")) : json("")), 160);
            if (data["people"].size() >= MaxPeople) throw std::runtime_error("The dossier library already contains 2,000 people.");
            json person = {{"id", NewId("person-")}, {"name", name}, {"pins", json::array()}, {"createdAt", Stamp()}};
            if (actor.is_object()) { actor.erase("name"); actor.erase("runtimeFormId"); person["actor"] = actor; }
            reply["personId"] = person["id"];
            data["people"].push_back(person);
            Event(data, json::array({person["id"]}), "person", "Added " + name + " to the dossier library.");
            return true;
        }
        if (op == "addRelation") {
            auto from = Text(request.at("from"), 160), to = Text(request.at("to"), 160);
            const auto kind = Text(request.at("kind"), 32);
            if (!Parent(kind) && kind != "spouse" && kind != "partner" && kind != "ex-partner") throw std::runtime_error("Choose a supported family relationship.");
            if (from == to) throw std::runtime_error("A person cannot be linked to themselves.");
            auto& a = Person(data, from); auto& b = Person(data, to);
            const auto description = a.value("name", std::string("Person")) + " / " + b.value("name", std::string("Person")) + ": " + kind;
            if (!Parent(kind) && to < from) std::swap(from, to);
            for (const auto& relation : data["relations"]) {
                const auto existing = relation.value("kind", std::string());
                const bool sameDirection = relation.value("from", std::string()) == from && relation.value("to", std::string()) == to;
                const bool reverseDirection = relation.value("from", std::string()) == to && relation.value("to", std::string()) == from;
                if ((existing == kind && (sameDirection || (!Parent(kind) && reverseDirection))) ||
                    (Parent(kind) && Parent(existing) && sameDirection))
                    throw std::runtime_error("That relationship is already recorded. Remove it first to change its type.");
            }
            if (Parent(kind) && Descends(data, to, from)) throw std::runtime_error("That parent link would make a person their own ancestor.");
            if (data["relations"].size() >= MaxRelations) throw std::runtime_error("The family library is full.");
            json relation = {{"id", NewId("relation-")}, {"from", from}, {"to", to}, {"kind", kind}, {"createdAt", Stamp()}};
            data["relations"].push_back(relation); reply["relationId"] = relation["id"];
            Event(data, json::array({from, to}), "relationship", "Recorded " + description + "."); return true;
        }
        if (op == "removeRelation") {
            const auto id = Text(request.at("relationId"), 160); auto& relations = data["relations"];
            for (auto i = relations.begin(); i != relations.end(); ++i) if (i->value("id", std::string()) == id) {
                const auto a = i->at("from"), b = i->at("to");
                const auto text = "Removed " + Person(data, a.get<std::string>()).value("name", std::string("Person")) + " / " + Person(data, b.get<std::string>()).value("name", std::string("Person")) + " relationship: " + i->value("kind", std::string()) + ".";
                relations.erase(i); Event(data, json::array({a, b}), "relationship", text); return true;
            }
            throw std::runtime_error("That relationship no longer exists.");
        }
        const auto id = Text(request.at("personId"), 160);
        auto& person = Person(data, id); reply["personId"] = id;
        const auto name = person.value("name", std::string("Person"));
        const auto before = person;
        std::string eventText, eventType = "preferences";
        if (op == "updatePerson") {
            if (request.contains("name")) person["name"] = Text(request["name"], 160);
            if (request.contains("householdRole")) person["householdRole"] = Text(request["householdRole"], 160, false);
            eventText = "Updated " + name + "'s profile."; eventType = "person";
        } else if (op == "bindActor") {
            auto actor = resolve(request.at("actor"));
            if (auto* other = FindActor(data, actor); other && other->at("id") != id)
                throw std::runtime_error("That NPC already has a dossier person. Choose that existing person; no family records were merged.");
            if (person.contains("actor") && !SameActor(person["actor"], actor))
                throw std::runtime_error("This person is already linked to a different NPC. The existing identity was kept.");
            actor.erase("name"); actor.erase("runtimeFormId"); person["actor"] = actor;
            eventText = "Linked " + name + " to a game NPC."; eventType = "person";
        } else if (op == "setPins") {
            const auto& pins = request.at("pins");
            if (!pins.is_array() || pins.size() > 4) throw std::runtime_error("Choose up to four pinned actions.");
            auto next = json::array(); std::set<std::string> seen;
            for (const auto& pin : pins) {
                const auto value = Text(pin, 120);
                if (!seen.insert(value).second) throw std::runtime_error("A pinned action cannot be listed twice.");
                if (value.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:-.") != std::string::npos)
                    throw std::runtime_error("A pinned action has an invalid identifier.");
                next.push_back(value);
            }
            person["pins"] = next; eventText = "Changed " + name + "'s pinned actions."; eventType = "pins";
        } else if (op == "setEquipment") {
            const auto& slots = request.at("slots");
            if (!slots.is_object()) throw std::runtime_error("Choose wardrobe presets for the equipment slots.");
            for (auto i = slots.begin(); i != slots.end(); ++i)
                if (i.key() != "everyday" && i.key() != "travel" && i.key() != "combat") throw std::runtime_error("Unknown wardrobe preset slot.");
            if (!person.contains("equipment")) person["equipment"] = json::object();
            if (!person["equipment"].is_object()) throw std::runtime_error("Existing equipment preferences could not be read.");
            for (auto i = slots.begin(); i != slots.end(); ++i) person["equipment"][i.key()] = Text(i.value(), 240, false);
            eventText = "Changed " + name + "'s wardrobe presets."; eventType = "equipment";
        } else if (op == "setPortrait") {
            const auto file = PortraitPath(request.at("file"));
            if (!person.contains("portrait")) person["portrait"] = json::object();
            if (!person["portrait"].is_object()) throw std::runtime_error("Existing portrait preferences could not be read.");
            person["portrait"]["file"] = file; eventText = "Changed " + name + "'s page portrait."; eventType = "portrait";
        } else if (op == "recordAction") {
            const auto action = Text(request.at("action"), 40);
            const auto detail = Text(request.at("detail"), 240);
            if (action != "outfit-requested" && action != "home-requested")
                throw std::runtime_error("That action cannot be recorded in dossier history.");
            Event(data, json::array({id}), action == "outfit-requested" ? "equipment" : "home",
                "Requested " + std::string(action == "outfit-requested" ? "outfit" : "home") + " change for " + name + ": " + detail + ".");
            reply["eventId"] = data["history"].back()["id"]; return true;
        } else if (op == "addNote") {
            const auto note = Text(request.at("text"), 4000, true, true);
            Event(data, json::array({id}), "note", note); reply["eventId"] = data["history"].back()["id"]; return true;
        } else if (op == "deleteNote") {
            const auto eventId = Text(request.at("eventId"), 160); auto& events = data["history"];
            for (auto i = events.begin(); i != events.end(); ++i) if (i->value("id", std::string()) == eventId) {
                if (i->value("type", std::string()) != "note" || !i->contains("personIds") || !(*i)["personIds"].is_array() ||
                    std::find((*i)["personIds"].begin(), (*i)["personIds"].end(), json(id)) == (*i)["personIds"].end())
                    throw std::runtime_error("Only this person's manual notes can be removed here.");
                events.erase(i); return true;
            }
            throw std::runtime_error("That note no longer exists.");
        } else throw std::runtime_error("Unknown dossier action.");
        if (person == before) return false;
        person["updatedAt"] = Stamp(); Event(data, json::array({id}), eventType, eventText); return true;
    }

    json EngineActor(const json& input)
    {
        if (!input.is_object()) throw std::runtime_error("Choose an NPC from the roster.");
        const auto formId = Text(input.at("formId"), 32);
        const auto plugin = Text(input.value("plugin", json("")), 260, false);
        const auto name = Text(input.value("name", json("")), 160, false);
#ifndef DOSSIER_STORE_TEST
        auto* actor = ActorIdentity::ResolveActor(formId, plugin);
        if (!actor || actor->IsDeleted()) throw std::runtime_error("That NPC could not be resolved. You can add a manual person instead.");
        if (!name.empty() && ActorIdentity::ResolvesToStranger(formId, plugin, name))
            throw std::runtime_error("That reference resolves to a different NPC. Refresh the roster before linking them.");
        std::string durableId, durablePlugin;
        if (!ActorIdentity::DurableOf(actor, durableId, durablePlugin))
            throw std::runtime_error("This spawned NPC has no permanent identity. Add a manual person to keep their family records.");
        return {{"formId", durableId}, {"plugin", durablePlugin}, {"name", actor->GetDisplayFullName()}, {"runtimeFormId", ActorIdentity::HexOf(actor->GetFormID())}};
#else
        // Test builds inject their own resolver into Apply; Handle has no engine.
        throw std::runtime_error("No engine actor resolver in this test build.");
#endif
    }
}

json Handle(const json& request)
{
    json reply = {{"ok", false}, {"op", ""}, {"msg", ""}};
    if (request.is_object() && request.contains("requestId") && request["requestId"].is_string() && request["requestId"].get_ref<const std::string&>().size() <= 160)
        reply["requestId"] = request["requestId"];
    try {
        if (!request.is_object() || request.dump().size() > 32768) throw std::runtime_error("The dossier request is invalid or too large.");
        const auto op = request.value("op", std::string("list"));
        // Resolving portraits/navigation needs no sidecar IO or full graph reply.
        if (op == "resolveActor") {
            auto empty = Empty(); Apply(empty, request, EngineActor, reply);
            reply["ok"] = true; return reply;
        }
        auto data = Read();
        const bool receipt = reply.contains("requestId") && op != "read" && op != "list" && op != "resolveActor";
        if (receipt && data.contains("_requests")) {
            if (!data["_requests"].is_array()) throw std::runtime_error("The dossier request history could not be read; the file was left untouched.");
            for (const auto& previous : data["_requests"]) if (previous.value("requestId", json()) == request["requestId"]) {
                if (!previous.contains("request") || previous["request"] != request)
                    throw std::runtime_error("That request identifier was already used. Retry with a new identifier.");
                reply = previous.at("response"); data.erase("_requests"); reply["data"] = std::move(data); return reply;
            }
        }
        const bool changed = Apply(data, request, EngineActor, reply);
        reply["ok"] = true; reply["msg"] = changed ? "Saved." : "";
        if (receipt) {
            if (!data.contains("_requests")) data["_requests"] = json::array();
            auto& requests = data["_requests"];
            while (requests.size() >= 256) requests.erase(requests.begin());
            requests.push_back({{"requestId", request["requestId"]}, {"request", request}, {"response", reply}});
        }
        if (changed || receipt) { Write(data);
#ifndef DOSSIER_STORE_TEST
            logger::info("dossier-store: saved {}", reply.value("op", std::string()));
#endif
        }
        data.erase("_requests");
        reply["data"] = std::move(data);
    } catch (const std::exception& e) { reply["ok"] = false; reply["msg"] = e.what(); }
    return reply;
}
std::string Handle(const std::string& request)
{
    const auto parsed = json::parse(request, nullptr, false);
    return Handle(parsed).dump(-1, ' ', false, json::error_handler_t::replace);
}

void ProcessPortalQueue(const std::filesystem::path& viewDir)
{
    // Called on the same main-thread bridge as Handle: no other writer owns this
    // sidecar. The phone submits separate files, never a shared read/clear list.
    try {
        const auto inbox = viewDir / "dossier-requests", outbox = viewDir / "dossier-results";
        if (!std::filesystem::exists(inbox)) return;
        std::filesystem::create_directories(outbox);
        std::size_t processed = 0, examined = 0;
        for (const auto& entry : std::filesystem::directory_iterator(inbox)) {
            if (++examined > 1000 || processed >= 10) break;
            if (!entry.is_regular_file()) continue;
            const auto extension = entry.path().extension();
            if (extension != ".json" && extension != ".processing") continue;
            const auto stemU8 = entry.path().stem().u8string();
            const std::string id(reinterpret_cast<const char*>(stemU8.data()), stemU8.size());
            if (id.empty() || id.size() > 64 || id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != std::string::npos) continue;
            auto claim = inbox / (id + ".processing");
            if (extension == ".json") {
                // A previous claim for this ID takes priority after interruption.
                if (std::filesystem::exists(claim)) continue;
                std::filesystem::rename(entry.path(), claim);
            }
            ++processed;
            json result = {{"ok", false}, {"requestId", id}, {"msg", "The queued dossier request is invalid."}};
            if (std::filesystem::file_size(claim) <= 32768) {
                std::ifstream input(claim, std::ios::binary); const auto request = json::parse(input, nullptr, false);
                if (request.is_object() && request.value("requestId", json()) == id) result = Handle(request);
            }
            // A crash after Handle's atomic save is replayed using its receipt.
            // Only remove the claim once its result is safely published.
            WriteFile(outbox / (id + ".json"), result);
            std::filesystem::remove(claim);
        }
        std::vector<std::filesystem::directory_entry> results;
        for (const auto& entry : std::filesystem::directory_iterator(outbox)) {
            if (entry.is_regular_file() && entry.path().extension() == ".json") results.push_back(entry);
            if (results.size() >= 1000) break;
        }
        if (results.size() > 100) {
            std::sort(results.begin(), results.end(), [](const auto& a, const auto& b) { return a.last_write_time() > b.last_write_time(); });
            for (std::size_t i = 100; i < results.size(); ++i) std::filesystem::remove(results[i].path());
        }
    } catch (const std::exception& e) {
#ifndef DOSSIER_STORE_TEST
        logger::warn("dossier-store: portal queue deferred: {}", e.what());
#else
        (void)e;
#endif
    }
}
}
