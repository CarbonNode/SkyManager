#include "npc_actions.h"
#include "conversation_hold_policy.h"
#include "npc_clearance.h"
#include "ostim_deck.h"
#include <chrono>
#include <cmath>
#include <unordered_map>
#include <vector>

// The NpcActions movement owner, shared by F7 and the phone. Deliberately
// independent of CHIM's LLM, follower membership and quest package priority.
// No AI disable, follower wait order, speed-value edit or quest/alias mutation:
// speech stays alive and release only removes the movement bit we acquired.
namespace NpcActions
{
    namespace
    {
        using json = nlohmann::json;
        using Clock = std::chrono::steady_clock;
        constexpr auto Blocked = RE::Actor::BOOL_FLAGS::kMovementBlocked;
        constexpr std::uint32_t Record = 0x4348544B; // CHTK in SkyManager's existing co-save
        struct Hold {
            RE::FormID id = 0, base = 0, cell = 0, playerCell = 0;
            RE::NiPoint3 anchor{};
            bool wasBlocked = false;
            double remaining = ConversationHoldPolicy::Duration;
            Clock::time_point tick = Clock::now();
            std::string name;
        };
        std::unordered_map<RE::FormID, Hold> holds;
        std::vector<Hold> restoreAfterLoad;

        std::string Dump(const json& j) { return j.dump(-1, ' ', false, json::error_handler_t::replace); }
        bool Finite(const RE::NiPoint3& p) { return std::isfinite(p.x) && std::isfinite(p.y) && std::isfinite(p.z); }
        float Distance(const RE::NiPoint3& a, const RE::NiPoint3& b) { return (a - b).Length(); }
        RE::Actor* ActorFor(const Hold& h)
        {
            auto* a = RE::TESForm::LookupByID<RE::Actor>(h.id);
            return a && a->GetActorBase() && a->GetActorBase()->GetFormID() == h.base ? a : nullptr;
        }
        bool Busy(RE::Actor* a)
        {
            if (a->IsInCombat() || a->IsInKillMove() || NpcClearance::IsHeld(a->GetFormID()) ||
                OstimDeck::ActorInScene(a->GetFormID())) return true;
            RE::NiPointer<RE::Actor> mount;
            if ((a->GetMount(mount) && mount) || (a->GetMountedBy(mount) && mount)) return true;
            auto* s = a->AsActorState();
            return s && (s->IsFlying() || s->IsSwimming() || s->IsBleedingOut() ||
                s->GetSitSleepState() != RE::SIT_SLEEP_STATE::kNormal);
        }
        bool Restore(const Hold& h, bool recoveringSave = false)
        {
            if (auto* a = ActorFor(h)) {
                // A pre-existing movement lock belongs to somebody else.
                // Recovery is authoritative for the loaded save. Runtime pose
                // maps may still describe the outgoing save; they must not
                // strand this save's conversation actor. Our controls cannot
                // own both holds in one save: changing pose releases ours first.
                if (!h.wasBlocked && (recoveringSave || !HasPoseHold(h.id))) a->GetActorRuntimeData().boolFlags.reset(Blocked);
                if (!a->IsDead() && !a->IsDisabled()) a->EvaluatePackage();
                return true;
            }
            return false;
        }
        void RestorePending()
        {
            for (auto it = restoreAfterLoad.begin(); it != restoreAfterLoad.end();)
                if (Restore(*it, true)) it = restoreAfterLoad.erase(it); else ++it;
        }
        void Pin(RE::Actor* a)
        {
            a->GetActorRuntimeData().boolFlags.set(Blocked);
            a->StopMoving(1.0f);
        }
    }

    void ReleaseConversation(std::uint32_t id, const char* reason)
    {
        for (auto it = holds.begin(); it != holds.end();) {
            if (id && it->first != id) { ++it; continue; }
            Restore(it->second);
            logger::info("conversation-hold: released {} ({:08X}): {}", it->second.name, it->first, reason);
            it = holds.erase(it);
        }
    }

    std::string ConversationControl(const std::string& request)
    {
        auto j = json::parse(request, nullptr, false);
        json out = {{"ok", false}};
        auto finish = [&](const std::string& msg) { out["msg"] = msg; return Dump(out); };
        if (!j.is_object()) return finish("Invalid conversation request");
        if (j.contains("requestId") && j["requestId"].is_string()) out["requestId"] = j["requestId"];
        if (!j.contains("formId") || !j["formId"].is_number_unsigned() ||
            j["formId"].get<std::uint64_t>() == 0 || j["formId"].get<std::uint64_t>() > 0xFFFFFFFFull ||
            !j.contains("name") || !j["name"].is_string() || !j.contains("op") || !j["op"].is_string())
            return finish("Choose a nearby NPC first");
        const auto id = j["formId"].get<std::uint32_t>();
        out["formId"] = id;
        const auto op = j["op"].get<std::string>();
        if (op != "start" && op != "release") return finish("Unknown conversation action");
        auto* a = RE::TESForm::LookupByID<RE::Actor>(id);
        auto* p = RE::PlayerCharacter::GetSingleton();
        if (!a || a->IsPlayerRef() || !a->GetActorBase() || !p || !p->GetParentCell())
            return finish("That NPC is not available in this game");
        const auto name = j["name"].get<std::string>();
        const char* baseName = a->GetActorBase()->GetFullName();
        const char* displayName = a->GetDisplayFullName();
        if (name.empty() || (name != (baseName ? baseName : "") && name != (displayName ? displayName : "")))
            return finish("NPC identity changed — reopen their card");
        out["name"] = name;
        if (op == "release") {
            const bool had = holds.count(id) != 0;
            ReleaseConversation(id, "Let them continue");
            out["ok"] = true; out["active"] = false;
            return finish(had ? name + " can continue" : name + " has no Stay and talk hold");
        }
        if (a->IsDead() || a->IsDisabled() || !a->Is3DLoaded() || !a->GetParentCell() ||
            !Finite(a->GetPosition()) || !Finite(p->GetPosition())) return finish("NPC is not nearby and loaded");
        const bool nearCell = a->GetParentCell() == p->GetParentCell() ||
            (!a->GetParentCell()->IsInteriorCell() && !p->GetParentCell()->IsInteriorCell() && a->GetWorldspace() == p->GetWorldspace());
        if (!nearCell || Distance(a->GetPosition(), p->GetPosition()) > ConversationHoldPolicy::StartRange)
            return finish("Get closer to " + name + " first");
        if (HasPoseHold(id)) return finish(name + " already has a Freeze, furniture or Grab hold — release it first");
        if (p->IsInCombat() || Busy(a)) return finish("Finish combat, riding or the current animation before talking");
        auto it = holds.find(id);
        if (it == holds.end()) {
            if (holds.size() >= 8) return finish("Eight conversation holds are active — let someone continue first");
            Hold h; h.id = id; h.base = a->GetActorBase()->GetFormID(); h.cell = a->GetParentCell()->GetFormID();
            h.playerCell = p->GetParentCell()->GetFormID(); h.anchor = a->GetPosition(); h.name = name;
            h.wasBlocked = a->GetActorRuntimeData().boolFlags.any(Blocked);
            // Borrowing another movement lock would make release ownership
            // ambiguous. Leave existing Freeze/scene controls entirely alone.
            if (h.wasBlocked) return finish(name + " already has a movement hold — release that control first");
            it = holds.emplace(id, std::move(h)).first;
        }
        it->second.remaining = ConversationHoldPolicy::Duration;
        it->second.tick = Clock::now();
        Pin(a);
        out["ok"] = true; out["active"] = true; out["seconds"] = 300;
        logger::info("conversation-hold: holding {} ({:08X}) independently of quest AI", name, id);
        return finish(name + " held here for up to five minutes. Let them continue releases the hold.");
    }

    void TickConversations(bool gameReady, bool paused)
    {
        if (!gameReady) return;
        RestorePending();
        if (holds.empty()) return;
        auto* p = RE::PlayerCharacter::GetSingleton();
        const auto now = Clock::now();
        for (auto it = holds.begin(); it != holds.end();) {
            auto& h = it->second;
            const auto elapsed = std::chrono::duration<double>(now - h.tick).count();
            h.tick = now;
            if (!paused) h.remaining -= elapsed;
            auto* a = ActorFor(h);
            const bool available = a && p && !a->IsDead() && !a->IsDisabled() && a->Is3DLoaded() && !p->IsDead();
            const bool sameCell = available && a->GetParentCell() && p->GetParentCell() &&
                a->GetParentCell()->GetFormID() == h.cell && p->GetParentCell()->GetFormID() == h.playerCell;
            const auto decision = ConversationHoldPolicy::Step(paused, available, sameCell,
                available && (Busy(a) || HasPoseHold(h.id) || p->IsInCombat()), h.remaining,
                available ? Distance(p->GetPosition(), h.anchor) : 0,
                available ? Distance(a->GetPosition(), h.anchor) : 0);
            if (decision == ConversationHoldPolicy::Decision::Release) {
                Restore(h);
                logger::info("conversation-hold: auto-release {} ({:08X})", h.name, h.id);
                RE::DebugNotification((h.name + " can continue (conversation hold ended)").c_str());
                it = holds.erase(it); continue;
            }
            if (decision != ConversationHoldPolicy::Decision::Pause) {
                Pin(a);
                // Some quest travel/animation controllers ignore a movement
                // block. Correct local drift only; never fight a scripted
                // teleport, another cell, a scene animation or combat.
                if (decision == ConversationHoldPolicy::Decision::Correct)
                    a->SetPosition(h.anchor, true);
            }
            ++it;
        }
    }

    void SaveConversations(SKSE::SerializationInterface* s)
    {
        json rows = json::array();
        for (const auto& [id, h] : holds) rows.push_back({{"id", id}, {"base", h.base}, {"blocked", h.wasBlocked}});
        for (const auto& h : restoreAfterLoad) rows.push_back({{"id", h.id}, {"base", h.base}, {"blocked", h.wasBlocked}});
        const auto data = Dump(rows);
        if (s->OpenRecord(Record, 1)) s->WriteRecordData(data.data(), static_cast<std::uint32_t>(data.size()));
    }
    bool LoadConversations(SKSE::SerializationInterface* s, std::uint32_t type, std::uint32_t version, std::uint32_t length)
    {
        if (type != Record) return false;
        if (version != 1 || length > 65536) return true;
        std::string data(length, '\0');
        if (s->ReadRecordData(data.data(), length) != length) return true;
        const auto rows = json::parse(data, nullptr, false);
        if (!rows.is_array() || rows.size() > 256) return true;
        for (const auto& row : rows) {
            if (!row.is_object() || !row.contains("id") || !row["id"].is_number_unsigned() ||
                !row.contains("base") || !row["base"].is_number_unsigned() ||
                !row.contains("blocked") || !row["blocked"].is_boolean()) continue;
            Hold h;
            if (s->ResolveFormID(row["id"].get<std::uint32_t>(), h.id) &&
                s->ResolveFormID(row["base"].get<std::uint32_t>(), h.base)) {
                h.wasBlocked = row["blocked"].get<bool>(); restoreAfterLoad.push_back(h);
            }
        }
        return true;
    }
    void RevertConversations() { holds.clear(); restoreAfterLoad.clear(); }
    void RestoreConversationsAfterLoad()
    {
        // Only this save's remapped recovery entries, never outgoing raw IDs.
        holds.clear();
        RestorePending(); // unloaded references retry on the ordinary main-thread tick
    }
}
