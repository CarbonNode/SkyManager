#include "spell_actions.h"

#include "actor_identity.h"
#include "npc_actions.h"  // reuse the crosshair target snapshotted at menu-open

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <thread>
#include <unordered_set>
#include <vector>

// pch (force-included) provides RE::/SKSE::, nlohmann json.hpp, and
// `using namespace std::literals`.

// <Windows.h> (pulled in transitively for the deck's SendInput) defines
// GetObject as an object-like macro -> GetObjectA, which mangles
// BGSDefaultObjectManager::GetObject<T> below. We don't use the GDI call
// here, so drop the macro for this translation unit.
#undef GetObject

namespace SpellActions
{
	namespace
	{
		// Voice-slot truth comes from the ENGINE: Actor's runtime `selectedPower`
		// holds whatever power/shout currently sits in the voice slot. The old
		// shadow-set here claimed success even when the equip call silently did
		// nothing for powers — which is exactly the lie Rober caught in-game.

		// True while a combo sequence is mid-flight; a second combo click is
		// refused instead of interleaving two barrages on the same caster.
		std::atomic<bool> g_sequenceActive{ false };

		// ---- small helpers ----

		void Notify(const std::string& msg) { RE::DebugNotification(msg.c_str()); }

		std::string NameOf(RE::SpellItem* s)
		{
			if (s) {
				const char* n = s->GetFullName();
				if (n && n[0])
					return n;
			}
			return "spell";
		}

		std::string HexId(RE::FormID id)
		{
			char buf[11];
			std::snprintf(buf, sizeof(buf), "0x%08X", id);
			return buf;
		}

		// GetFile(0) = the file that first defined the form. Handles ESL/ESM/ESP
		// alike — same idiom quest_tools::PluginOf uses.
		std::string PluginOf(RE::TESForm* form)
		{
			if (form) {
				if (auto* file = form->GetFile(0))
					return std::string(file->GetFilename());
			}
			return "";
		}

		const char* TypeName(RE::MagicSystem::SpellType t)
		{
			using T = RE::MagicSystem::SpellType;
			switch (t) {
			case T::kSpell:       return "spell";
			case T::kPower:       return "power";
			case T::kLesserPower: return "lesser";
			case T::kVoicePower:  return "voice";
			default:              return "other";
			}
		}

		const char* DeliveryName(RE::MagicSystem::Delivery d)
		{
			using D = RE::MagicSystem::Delivery;
			switch (d) {
			case D::kSelf:           return "self";
			case D::kTouch:          return "touch";
			case D::kAimed:          return "aimed";
			case D::kTargetActor:    return "target";
			case D::kTargetLocation: return "location";
			default:                 return "other";
			}
		}

		const char* CastingName(RE::MagicSystem::CastingType c)
		{
			using C = RE::MagicSystem::CastingType;
			switch (c) {
			case C::kConstantEffect: return "constant";
			case C::kFireAndForget:  return "fire";
			case C::kConcentration:  return "concentration";
			case C::kScroll:         return "scroll";
			default:                 return "other";
			}
		}

		// ---- icon metadata (drives the Spell Deck's magic-menu-style icons) ----
		// School / element / archetype are exactly what the vanilla magic menu
		// keys its icons off of. We emit them so the view can reproduce that
		// visual language without extracting the skin's SWF art.

		const char* SchoolName(RE::ActorValue av)
		{
			using AV = RE::ActorValue;
			switch (av) {
			case AV::kAlteration:  return "alteration";
			case AV::kConjuration: return "conjuration";
			case AV::kDestruction: return "destruction";
			case AV::kIllusion:    return "illusion";
			case AV::kRestoration: return "restoration";
			default:               return "";
			}
		}

		const char* ElementName(RE::ActorValue av)
		{
			using AV = RE::ActorValue;
			switch (av) {
			case AV::kResistFire:  return "fire";
			case AV::kResistFrost: return "frost";
			case AV::kResistShock: return "shock";
			default:               return "";
			}
		}

		// Only the archetypes that read clearer than a bare school glyph; every
		// other archetype falls back to the school icon in the view.
		const char* ArchetypeKey(RE::EffectArchetype a)
		{
			using A = RE::EffectArchetype;
			switch (a) {
			case A::kBoundWeapon:    return "bound";
			case A::kSummonCreature: return "summon";
			case A::kReanimate:      return "reanimate";
			case A::kLight:          return "light";
			case A::kDetectLife:     return "detect";
			case A::kParalysis:      return "paralysis";
			case A::kTelekinesis:    return "telekinesis";
			case A::kSoulTrap:       return "soultrap";
			case A::kTurnUndead:     return "turnundead";
			case A::kBanish:         return "banish";
			case A::kInvisibility:   return "invisibility";
			case A::kCalm:           return "calm";
			case A::kFrenzy:         return "frenzy";
			case A::kDemoralize:     return "fear";
			case A::kRally:          return "rally";
			case A::kCloak:          return "cloak";
			default:                 return "";
			}
		}

		// Only hand-castable "spells" get L/R slots; powers/shouts use the voice slot.
		bool IsHandSpell(RE::SpellItem* s)
		{
			return s && s->GetSpellType() == RE::MagicSystem::SpellType::kSpell;
		}

		// Skill tier from the costliest effect's minimum skill — the same 0/25/50/
		// 75/100 steps the game uses for spell-tome leveling. Drives which tier of
		// generic icon the view picks (DESTRUCTION_FIRE_ADEPT vs _MASTER, …).
		// Powers / shouts have no tier; return "".
		std::string TierOf(RE::SpellItem* s)
		{
			if (!IsHandSpell(s))
				return "";
			const auto* eff = s->GetCostliestEffectItem();
			const auto* base = eff ? eff->baseEffect : nullptr;
			const auto  min = base ? base->data.minimumSkill : 0;
			if (min >= 100) return "master";
			if (min >= 75)  return "expert";
			if (min >= 50)  return "adept";
			if (min >= 25)  return "apprentice";
			return "novice";
		}

		// Icon metadata: school (the magic-menu tab), element (Destruction splits
		// fire/frost/shock) and a distinctive-archetype hint — keyed exactly as the
		// vanilla magic menu keys its icons. Shared by KnownSpellsJson and the
		// removed-spell flow: a removed spell drops out of the known-spells set, so
		// its icon data has to be captured and carried with it.
		void FillIconMeta(RE::SpellItem* s, std::string& school, std::string& element, std::string& archetype)
		{
			school.clear();
			element.clear();
			archetype.clear();
			if (!s)
				return;
			if (auto skill = s->GetAssociatedSkill(); skill != RE::ActorValue::kNone)
				school = SchoolName(skill);
			if (auto* eff = s->GetAVEffect()) {
				element   = ElementName(eff->data.resistVariable);
				archetype = ArchetypeKey(eff->GetArchetype());
				if (school.empty())
					school = SchoolName(eff->GetMagickSkill());
			}
		}

		bool IsCastableType(RE::MagicSystem::SpellType t)
		{
			using T = RE::MagicSystem::SpellType;
			return t == T::kSpell || t == T::kPower || t == T::kLesserPower || t == T::kVoicePower;
		}

		// Durable resolve: (plugin, localId) first, raw formId as fallback.
		RE::SpellItem* ResolveSpell(const std::string& plugin, std::uint32_t localId, std::uint32_t formId)
		{
			if (auto* dh = RE::TESDataHandler::GetSingleton()) {
				if (!plugin.empty() && localId) {
					if (auto* f = dh->LookupForm(localId, plugin))
						if (auto* s = f->As<RE::SpellItem>())
							return s;
				}
			}
			if (formId) {
				if (auto* f = RE::TESForm::LookupByID(formId))
					if (auto* s = f->As<RE::SpellItem>())
						return s;
			}
			return nullptr;
		}

		// Shouts are TESShout, not SpellItem — same durable-resolve scheme.
		RE::TESShout* ResolveShout(const std::string& plugin, std::uint32_t localId, std::uint32_t formId)
		{
			if (auto* dh = RE::TESDataHandler::GetSingleton()) {
				if (!plugin.empty() && localId) {
					if (auto* f = dh->LookupForm(localId, plugin))
						if (auto* s = f->As<RE::TESShout>())
							return s;
				}
			}
			if (formId) {
				if (auto* f = RE::TESForm::LookupByID(formId))
					if (auto* s = f->As<RE::TESShout>())
						return s;
			}
			return nullptr;
		}

		std::string NameOfShout(RE::TESShout* s)
		{
			if (s) {
				const char* n = s->GetFullName();
				if (n && n[0])
					return n;
			}
			return "shout";
		}

		// What the voice slot holds RIGHT NOW (a power SpellItem or a TESShout).
		RE::TESForm* SelectedPower()
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			return player ? player->GetActorRuntimeData().selectedPower : nullptr;
		}

		// The DIK scan code the game itself has the Shout/Power control mapped
		// to (respects rebinds). 0x2C = Z, the vanilla default, as fallback.
		std::uint32_t ShoutKeyDik()
		{
			if (auto* cm = RE::ControlMap::GetSingleton()) {
				if (auto* ue = RE::UserEvents::GetSingleton()) {
					const auto k = cm->GetMappedKey(ue->shout, RE::INPUT_DEVICE::kKeyboard);
					if (k != 0xFF && k != 0)
						return k;
				}
			}
			return 0x2C;
		}

		// Minimal SendInput scancode press — sibling of main.cpp's SendScan
		// (which lives in another TU's anonymous namespace). Voice-slot casts
		// go through the game's OWN key so the engine runs the real Z-press
		// path: cooldown, animation, perks, everything.
		void SendDikKey(std::uint32_t dik, bool down)
		{
			INPUT in{};
			in.type = INPUT_KEYBOARD;
			in.ki.wScan = static_cast<WORD>(dik & 0x7F);
			in.ki.dwFlags = KEYEVENTF_SCANCODE;
			if (dik > 0x7F)
				in.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
			if (!down)
				in.ki.dwFlags |= KEYEVENTF_KEYUP;
			::SendInput(1, &in, sizeof(INPUT));
		}

		const RE::BGSEquipSlot* HandSlot(bool left)
		{
			auto* dobj = RE::BGSDefaultObjectManager::GetSingleton();
			if (!dobj)
				return nullptr;
			return dobj->GetObject<RE::BGSEquipSlot>(
				left ? RE::DEFAULT_OBJECT::kLeftHandEquip : RE::DEFAULT_OBJECT::kRightHandEquip);
		}

		// The shared cast core: self-delivery spells self-cast, everything else
		// targets the crosshair actor snapshotted at menu-open, or fires forward.
		// Main thread only. Returns false when the world isn't ready for it.
		bool DoCast(RE::SpellItem* spell)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player || !spell)
				return false;
			auto* caster = player->GetMagicCaster(RE::MagicSystem::CastingSource::kInstant);
			if (!caster)
				return false;

			RE::TESObjectREFR* target = player;  // self-cast default
			if (spell->GetDelivery() != RE::MagicSystem::Delivery::kSelf) {
				target = nullptr;  // fire forward when nothing is targeted
				if (auto id = NpcActions::TargetFormID()) {
					if (auto* a = RE::TESForm::LookupByID<RE::Actor>(id))
						target = a;
				}
			}

			caster->CastSpellImmediate(spell, false, target, 1.0f, false, 0.0f, player);
			return true;
		}

		// Actor.UnequipSpell(Spell akSpell, int aiSource) — there is no native
		// ActorEquipManager::UnequipSpell, so we dispatch the Papyrus method the
		// same way npc_actions::CallActorBool dispatches SetRestrained.
		// aiSource: 0 = left hand, 1 = right hand, 2 = voice/other.
		void UnequipSpellPapyrus(RE::Actor* actor, RE::SpellItem* spell, std::int32_t source)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm)
				return;
			auto* policy = vm->GetObjectHandlePolicy();
			auto  handle = policy->GetHandleForObject(RE::Actor::FORMTYPE, actor);
			if (handle == policy->EmptyHandle())
				return;
			auto args = RE::MakeFunctionArguments(
				std::move(static_cast<RE::SpellItem*>(spell)), std::move(source));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			vm->DispatchMethodCall(handle, "Actor", "UnequipSpell", args, cb);
		}

		// Actor.EquipSpell(Spell akSpell, int aiSource) — the Papyrus method
		// routes powers to the voice slot correctly, where the bare
		// ActorEquipManager::EquipSpell(…, nullptr) call proved unreliable.
		void EquipSpellPapyrus(RE::Actor* actor, RE::SpellItem* spell, std::int32_t source)
		{
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm)
				return;
			auto* policy = vm->GetObjectHandlePolicy();
			auto  handle = policy->GetHandleForObject(RE::Actor::FORMTYPE, actor);
			if (handle == policy->EmptyHandle())
				return;
			auto args = RE::MakeFunctionArguments(
				std::move(static_cast<RE::SpellItem*>(spell)), std::move(source));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			vm->DispatchMethodCall(handle, "Actor", "EquipSpell", args, cb);
		}

		// The voice-slot "cast": the item was just selected into the voice slot
		// (or already sat there); after the equip settles, press the game's own
		// mapped Shout key so the ENGINE does the cast. `wasSelected` skips the
		// long settle when no equip was needed. Detached thread; onDone hops
		// back to the main thread.
		void VoiceUse(const std::string& name, bool wasSelected, std::function<void()> onDone)
		{
			const auto dik = ShoutKeyDik();  // read on the main thread
			logger::info("voice-use via shout key: '{}' dik=0x{:X} selected={}", name, dik, wasSelected);
			std::thread([dik, wasSelected, onDone = std::move(onDone)]() {
				// Papyrus EquipSpell / EquipShout land asynchronously; give the
				// engine time to seat the power before pressing its key.
				std::this_thread::sleep_for(std::chrono::milliseconds(wasSelected ? 250 : 750));
				SendDikKey(dik, true);
				std::this_thread::sleep_for(std::chrono::milliseconds(140));  // tap = word 1 for shouts
				SendDikKey(dik, false);
				if (onDone)
					SKSE::GetTaskInterface()->AddTask([onDone]() { onDone(); });
			}).detach();
		}

		// Case-insensitive tag substitution for effect descriptions — vanilla
		// writes <mag>/<dur>/<area>, a few mods capitalise them.
		void ReplaceTag(std::string& text, std::string_view tag, const std::string& value)
		{
			for (std::size_t pos = 0; pos + tag.size() <= text.size();) {
				bool hit = true;
				for (std::size_t i = 0; i < tag.size(); ++i) {
					if (std::tolower(static_cast<unsigned char>(text[pos + i])) !=
						std::tolower(static_cast<unsigned char>(tag[i]))) {
						hit = false;
						break;
					}
				}
				if (hit) {
					text.replace(pos, tag.size(), value);
					pos += value.size();
				} else {
					++pos;
				}
			}
		}
	}

	void Init()
	{
		g_sequenceActive = false;
		logger::info("SpellActions: ready");
	}

	std::string KnownSpellsJson()
	{
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return "[]";

		std::unordered_set<RE::FormID> seen;
		std::vector<nlohmann::json>    rows;

		auto add = [&](RE::SpellItem* s) {
			if (!s)
				return;
			const auto type = s->GetSpellType();
			if (!IsCastableType(type))
				return;
			const auto id = s->GetFormID();
			if (!seen.insert(id).second)
				return;
			nlohmann::json o;
			o["plugin"]   = PluginOf(s);
			o["localId"]  = ActorIdentity::LocalIdOf(s);
			o["formId"]   = id;
			o["name"]     = NameOf(s);
			o["type"]     = TypeName(type);
			o["delivery"] = DeliveryName(s->GetDelivery());
			o["casting"]  = CastingName(s->GetCastingType());
			o["slot"]     = IsHandSpell(s) ? "hand" : "voice";

			std::string school, element, archetype;
			FillIconMeta(s, school, element, archetype);
			o["school"]    = school;
			o["element"]   = element;
			o["archetype"] = archetype;
			o["tier"]      = TierOf(s);
			rows.push_back(std::move(o));
		};

		// Spells baked into the actor base (SPLO record)...
		if (auto* base = player->GetActorBase()) {
			if (auto* data = base->GetSpellList()) {
				if (data->spells) {
					for (std::uint32_t i = 0; i < data->numSpells; ++i)
						add(data->spells[i]);
				}
			}
		}
		// ...plus every spell learned at runtime.
		for (auto* s : player->GetActorRuntimeData().addedSpells)
			add(s);

		// ...plus known SHOUTS. They are TESShout forms (never SpellItems), so
		// they were invisible to the deck entirely — Actor::HasShout filters the
		// full form array down to what the player actually has. Icon metadata
		// comes from the first word's spell so school/element icons still land.
		if (auto* dh = RE::TESDataHandler::GetSingleton()) {
			for (auto* sh : dh->GetFormArray<RE::TESShout>()) {
				if (!sh || !player->HasShout(sh))
					continue;
				const auto id = sh->GetFormID();
				if (!seen.insert(id).second)
					continue;
				auto* word0 = sh->variations[0].spell;
				nlohmann::json o;
				o["plugin"]   = PluginOf(sh);
				o["localId"]  = ActorIdentity::LocalIdOf(sh);
				o["formId"]   = id;
				o["name"]     = NameOfShout(sh);
				o["type"]     = "shout";
				o["delivery"] = word0 ? DeliveryName(word0->GetDelivery()) : "other";
				o["casting"]  = "other";
				o["slot"]     = "voice";
				std::string school, element, archetype;
				FillIconMeta(word0, school, element, archetype);
				o["school"]    = school;
				o["element"]   = element;
				o["archetype"] = archetype;
				o["tier"]      = "";
				rows.push_back(std::move(o));
			}
		}

		std::sort(rows.begin(), rows.end(), [](const nlohmann::json& a, const nlohmann::json& b) {
			return a.value("name", std::string{}) < b.value("name", std::string{});
		});

		nlohmann::json arr = nlohmann::json::array();
		for (auto& r : rows)
			arr.push_back(std::move(r));
		return arr.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string EquipStateJson()
	{
		nlohmann::json out;
		out["left"]  = "";
		out["right"] = "";
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (player) {
			if (auto* l = player->GetEquippedObject(true))
				out["left"] = HexId(l->GetFormID());
			if (auto* r = player->GetEquippedObject(false))
				out["right"] = HexId(r->GetFormID());
		}
		nlohmann::json voice = nlohmann::json::array();
		if (auto* sp = SelectedPower())
			voice.push_back(HexId(sp->GetFormID()));
		out["voice"] = std::move(voice);
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string Cast(const std::string& plugin, std::uint32_t localId, std::uint32_t formId,
		std::function<void()> onDone)
	{
		nlohmann::json res;
		auto*          player = RE::PlayerCharacter::GetSingleton();
		auto*          spell  = ResolveSpell(plugin, localId, formId);
		auto*          shout  = spell ? nullptr : ResolveShout(plugin, localId, formId);
		if (!player || (!spell && !shout)) {
			res["ok"] = false;
			res["msg"] = "Spell not found — re-add it";
			if (onDone)
				onDone();
			return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// Voice-slot family (greater/lesser powers, shouts): the instant magic
		// caster can't fire these reliably (and can't fire a TESShout at all).
		// Instead: select it in the voice slot, then press the game's own Shout
		// key — the engine runs the REAL Z-press path. onDone (palette reopen)
		// is deferred until after the key lands.
		if (shout || !IsHandSpell(spell)) {
			RE::TESForm*      self = shout ? static_cast<RE::TESForm*>(shout) : spell;
			const std::string name = shout ? NameOfShout(shout) : NameOf(spell);
			const bool        selected = SelectedPower() == self;
			if (!selected) {
				if (shout) {
					if (auto* eqm = RE::ActorEquipManager::GetSingleton())
						eqm->EquipShout(player, shout);
				} else {
					EquipSpellPapyrus(player, spell, 2);
				}
			}
			VoiceUse(name, selected, std::move(onDone));
			const std::string msg = "Using " + name;
			Notify(msg);
			res["ok"] = true;
			res["msg"] = msg;
			return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		if (!DoCast(spell)) {
			res["ok"] = false;
			res["msg"] = "Caster unavailable";
			if (onDone)
				onDone();
			return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		const std::string msg = "Cast " + NameOf(spell);
		Notify(msg);
		res["ok"] = true;
		res["msg"] = msg;
		if (onDone)
			onDone();
		return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	void CastSequence(const std::string& name, std::vector<SpellRef> refs,
		std::uint32_t staggerMs, std::function<void()> onDone)
	{
		const std::string label = name.empty() ? "Spell combo" : name;

		if (refs.empty()) {
			if (onDone)
				onDone();
			return;
		}
		if (g_sequenceActive.exchange(true)) {
			Notify("Still casting the last combo…");
			if (onDone)
				onDone();
			return;
		}

		// First spell fires right here on the main thread; one notification for
		// the whole barrage (per-spell "Cast X" spam is the single-cast path).
		if (auto* first = ResolveSpell(refs[0].plugin, refs[0].localId, refs[0].formId); first && DoCast(first))
			Notify("⚡ " + label);
		else {
			Notify("⚡ " + label + " — first spell unavailable");
			logger::warn("combo '{}': could not cast member 0", label);
		}

		if (refs.size() == 1) {
			g_sequenceActive = false;
			if (onDone)
				onDone();
			return;
		}

		// Pace the rest from a detached timer thread; every actual cast hops
		// back onto the main thread. staggerMs is clamped so a bad payload can
		// neither machine-gun the caster nor park the flag for minutes.
		staggerMs = std::clamp(staggerMs, 60u, 1000u);
		std::thread([label, refs = std::move(refs), staggerMs, onDone = std::move(onDone)]() {
			for (std::size_t i = 1; i < refs.size(); ++i) {
				std::this_thread::sleep_for(std::chrono::milliseconds(staggerMs));
				const auto ref = refs[i];
				SKSE::GetTaskInterface()->AddTask([label, ref, i]() {
					auto* s = ResolveSpell(ref.plugin, ref.localId, ref.formId);
					if (!s || !DoCast(s))
						logger::warn("combo '{}': could not cast member {}", label, i);
				});
			}
			std::this_thread::sleep_for(std::chrono::milliseconds(staggerMs));
			SKSE::GetTaskInterface()->AddTask([onDone]() {
				g_sequenceActive = false;
				if (onDone)
					onDone();
			});
		}).detach();
	}

	std::string EquipToggle(const std::string& plugin, std::uint32_t localId, std::uint32_t formId,
		const std::string& hand)
	{
		nlohmann::json res;
		auto*          player = RE::PlayerCharacter::GetSingleton();
		auto*          spell  = ResolveSpell(plugin, localId, formId);
		auto*          shout  = spell ? nullptr : ResolveShout(plugin, localId, formId);
		if (!player || (!spell && !shout)) {
			res["ok"] = false;
			res["msg"] = "Spell not found — re-add it";
			return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm) {
			res["ok"] = false;
			res["msg"] = "Equip system unavailable";
			return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		const auto  id   = shout ? shout->GetFormID() : spell->GetFormID();
		bool        newL = false, newR = false, newVoice = false;
		std::string msg;

		if (shout) {
			// Shouts: EquipShout selects it in the voice slot. There is no vanilla
			// "unequip shout" — the slot only ever changes to something ELSE — so
			// toggling an already-selected shout reports honestly instead.
			if (SelectedPower() == shout) {
				newVoice = true;
				msg = NameOfShout(shout) + " is already the equipped shout";
			} else {
				eqm->EquipShout(player, shout);
				newVoice = true;
				msg = "Equipped " + NameOfShout(shout) + " — shout key fires it";
			}
		} else if (!IsHandSpell(spell)) {
			// Power / lesser-power / voice — voice slot, ENGINE-truth toggle
			// (selectedPower), equipped via the Papyrus method that actually
			// routes powers correctly.
			if (SelectedPower() == spell) {
				UnequipSpellPapyrus(player, spell, 2);
				msg = "Unequipped " + NameOf(spell);
			} else {
				EquipSpellPapyrus(player, spell, 2);
				newVoice = true;
				msg = "Equipped " + NameOf(spell) + " — shout key fires it";
			}
		} else {
			// Hand spell — read true engine state, toggle the requested hand(s).
			const bool inLeft  = (player->GetEquippedObject(true) == spell);
			const bool inRight = (player->GetEquippedObject(false) == spell);

			auto equipHand = [&](bool left) { eqm->EquipSpell(player, spell, HandSlot(left)); };
			auto unequip   = [&](bool left) { UnequipSpellPapyrus(player, spell, left ? 0 : 1); };

			if (hand == "left") {
				if (inLeft) { unequip(true); msg = "Unequipped L: " + NameOf(spell); }
				else        { equipHand(true); newL = true; msg = "Equipped L: " + NameOf(spell); }
				newR = inRight;
			} else if (hand == "right") {
				if (inRight) { unequip(false); msg = "Unequipped R: " + NameOf(spell); }
				else         { equipHand(false); newR = true; msg = "Equipped R: " + NameOf(spell); }
				newL = inLeft;
			} else {  // both
				if (inLeft && inRight) {
					unequip(true);
					unequip(false);
					msg = "Unequipped: " + NameOf(spell);
				} else {
					equipHand(true);
					equipHand(false);
					newL = newR = true;
					msg = "Equipped (both): " + NameOf(spell);
				}
			}
		}

		Notify(msg);
		res["ok"]     = true;
		res["msg"]    = msg;
		res["formId"] = HexId(id);
		res["left"]   = newL;
		res["right"]  = newR;
		res["voice"]  = newVoice;
		return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string RemoveFromSpellbook(const std::string& plugin, std::uint32_t localId, std::uint32_t formId,
		bool notify)
	{
		nlohmann::json res;
		auto*          player = RE::PlayerCharacter::GetSingleton();
		auto*          spell  = ResolveSpell(plugin, localId, formId);
		if (!player || !spell) {
			res["ok"]  = false;
			res["msg"] = (player && ResolveShout(plugin, localId, formId))
			                 ? "Shouts can't be removed — words of power are known, not learned"
			                 : "Spell not found — nothing removed";
			return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		// Spells AND powers are removable (engine RemoveSpell handles both when
		// they were LEARNED); the guard below reports honestly for the racial/
		// perk/quest-granted ones RemoveSpell can't touch. Shouts are refused
		// above — a TESShout has no spellbook entry to pull.

		const auto id = spell->GetFormID();

		// RemoveSpell only succeeds for spells the player LEARNED (addedSpells).
		// Race/perk/quest-granted spells live on the actor base and can't be pulled
		// individually — report that honestly instead of leaving a ghost in the
		// Removed list that reappears in KnownSpellsJson on the next refresh.
		if (!player->RemoveSpell(spell)) {
			res["ok"]  = false;
			res["msg"] = "Can't remove " + NameOf(spell) + " — it's granted by race, perk, or quest";
			return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		logger::info("spellbook-remove '{}' (type {})", NameOf(spell), TypeName(spell->GetSpellType()));

		// Belt-and-braces: clear it from either hand — or the voice slot for a
		// power — so no ghost equip lingers.
		if (player->GetEquippedObject(true) == spell)
			UnequipSpellPapyrus(player, spell, 0);
		if (player->GetEquippedObject(false) == spell)
			UnequipSpellPapyrus(player, spell, 1);
		if (SelectedPower() == spell)
			UnequipSpellPapyrus(player, spell, 2);

		std::string school, element, archetype;
		FillIconMeta(spell, school, element, archetype);

		const std::string msg = "Removed " + NameOf(spell) + " from spellbook";
		if (notify)
			Notify(msg);
		res["ok"]        = true;
		res["msg"]       = msg;
		res["formId"]    = id;  // NUMBER (matches KnownSpellsJson), not a hex string
		res["plugin"]    = PluginOf(spell);
		res["localId"]   = ActorIdentity::LocalIdOf(spell);
		res["name"]      = NameOf(spell);
		res["type"]      = TypeName(spell->GetSpellType());
		res["school"]    = school;
		res["element"]   = element;
		res["archetype"] = archetype;
		res["tier"]      = TierOf(spell);
		return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string RestoreToSpellbook(const std::string& plugin, std::uint32_t localId, std::uint32_t formId)
	{
		nlohmann::json res;
		auto*          player = RE::PlayerCharacter::GetSingleton();
		auto*          spell  = ResolveSpell(plugin, localId, formId);
		if (!player || !spell) {
			res["ok"]  = false;
			res["msg"] = "Spell not found — cannot restore";
			return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		const auto  id = spell->GetFormID();
		std::string msg;
		if (player->HasSpell(spell)) {
			msg = NameOf(spell) + " is already known";  // idempotent
		} else {
			player->AddSpell(spell);
			msg = "Restored " + NameOf(spell);
			Notify(msg);
		}
		res["ok"]     = true;
		res["msg"]    = msg;
		res["formId"] = id;  // NUMBER
		return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string DescriptionJson(const std::string& plugin, std::uint32_t localId, std::uint32_t formId)
	{
		nlohmann::json res;
		// The formId echoed back is the CORRELATION TOKEN — it must be the id the
		// view ASKED with (it keys its pending-request/cache on that), not the
		// resolved runtime id. Echoing the resolved id left the tooltip spinning
		// on "Reading description…" forever whenever a load-order shift moved a
		// stored spell's runtime FormID.
		res["formId"] = formId;
		res["name"]   = "";
		res["text"]   = "";
		auto* spell = ResolveSpell(plugin, localId, formId);

		// Shouts: no effect list of their own — the shout's TESDescription if it
		// has one, else the first word's spell effects carry the text below.
		if (!spell) {
			if (auto* sh = ResolveShout(plugin, localId, formId)) {
				res["name"] = NameOfShout(sh);
				RE::BSString buf;
				sh->GetDescription(buf, nullptr);
				if (buf.length() > 0) {
					res["ok"]   = true;
					res["text"] = std::string(buf.c_str());
					return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
				}
				spell = sh->variations[0].spell;
			}
		}
		if (!spell) {
			res["ok"] = false;
			return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// Same text the vanilla item card shows: each visible effect's
		// magicItemDescription with its magnitude / duration / area filled in.
		std::string text;
		for (auto* eff : spell->effects) {
			auto* base = eff ? eff->baseEffect : nullptr;
			if (!base)
				continue;
			if (base->data.flags.any(RE::EffectSetting::EffectSettingData::Flag::kHideInUI))
				continue;
			// DNAM lives on EffectSetting as a plain BSFixedString — read it directly.
			const char* raw = base->magicItemDescription.c_str();
			std::string t = raw ? raw : "";
			if (t.empty())
				continue;
			ReplaceTag(t, "<mag>", std::to_string(static_cast<long long>(std::llround(eff->effectItem.magnitude))));
			ReplaceTag(t, "<dur>", std::to_string(eff->effectItem.duration));
			ReplaceTag(t, "<area>", std::to_string(eff->effectItem.area));
			if (!text.empty() && text.back() != ' ')
				text += ' ';
			text += t;
		}

		res["ok"] = true;
		if (res["name"].get<std::string>().empty())
			res["name"] = NameOf(spell);
		res["text"] = text;
		return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string HighlightedSpellJson()
	{
		nlohmann::json res;
		res["ok"] = false;

		RE::SpellItem* spell = nullptr;
		RE::TESShout*  shout = nullptr;
		const char*    src = "menu";

		// Primary: the spell (or shout) the vanilla Magic Menu's item card is
		// describing.
		if (auto* ui = RE::UI::GetSingleton()) {
			if (auto menu = ui->GetMenu<RE::MagicMenu>()) {
				auto& rt = menu->GetRuntimeData();
				if (auto* card = rt.itemCard) {
					RE::GFxValue fid;
					if (card->obj.IsObject() && card->obj.GetMember("formId", &fid) && fid.IsNumber()) {
						const auto id = static_cast<RE::FormID>(static_cast<std::uint32_t>(fid.GetNumber()));
						if (auto* f = RE::TESForm::LookupByID(id)) {
							spell = f->As<RE::SpellItem>();
							if (!spell)
								shout = f->As<RE::TESShout>();
						}
					}
				}
			}
		}

		if (shout) {
			std::string school, element, archetype;
			FillIconMeta(shout->variations[0].spell, school, element, archetype);
			res["ok"]        = true;
			res["src"]       = src;
			res["plugin"]    = PluginOf(shout);
			res["localId"]   = ActorIdentity::LocalIdOf(shout);
			res["formId"]    = shout->GetFormID();
			res["name"]      = NameOfShout(shout);
			res["type"]      = "shout";
			res["slot"]      = "voice";
			res["school"]    = school;
			res["element"]   = element;
			res["archetype"] = archetype;
			res["tier"]      = "";
			return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		// Fallback: whatever spell sits in a hand (right first). Covers card-read
		// misses and lets the key work outside the menu too.
		if (!spell) {
			src = "hand";
			if (auto* player = RE::PlayerCharacter::GetSingleton()) {
				if (auto* r = player->GetEquippedObject(false))
					spell = r->As<RE::SpellItem>();
				if (!spell) {
					if (auto* l = player->GetEquippedObject(true))
						spell = l->As<RE::SpellItem>();
				}
			}
		}
		if (!spell || !IsCastableType(spell->GetSpellType())) {
			res["msg"] = "No spell highlighted";
			return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		std::string school, element, archetype;
		FillIconMeta(spell, school, element, archetype);
		res["ok"]        = true;
		res["src"]       = src;
		res["plugin"]    = PluginOf(spell);
		res["localId"]   = ActorIdentity::LocalIdOf(spell);
		res["formId"]    = spell->GetFormID();
		res["name"]      = NameOf(spell);
		res["type"]      = TypeName(spell->GetSpellType());
		res["slot"]      = IsHandSpell(spell) ? "hand" : "voice";
		res["school"]    = school;
		res["element"]   = element;
		res["archetype"] = archetype;
		res["tier"]      = TierOf(spell);
		return res.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}
}
