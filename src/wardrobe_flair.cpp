#include "wardrobe_flair.h"
#include "wardrobe_flair_model.h"
#include "actor_identity.h"
#include "ostim_deck.h"
#include <chrono>
#ifdef GetObject
#undef GetObject
#endif
#ifdef min
#undef min
#endif
#ifdef max
#undef max
#endif

namespace WardrobeFlair
{
	using json = nlohmann::json;
	namespace {
		bool busy = false, pulse = true, resetOnPulse = true;
		std::uint64_t epoch = 0;
		auto nextPulse = std::chrono::steady_clock::now();
		std::string Result(bool ok, const std::string& msg) { return json{{"ok",ok},{"msg",msg}}.dump(-1,' ',false,json::error_handler_t::replace); }
		class Reply final : public RE::BSScript::IStackCallbackFunctor {
			std::function<void(const std::string&,bool)> done;
			std::uint64_t generation;
		public:
			explicit Reply(std::function<void(const std::string&,bool)> cb) : done(std::move(cb)), generation(epoch) {}
			void operator()(RE::BSScript::Variable value) override {
				std::string msg = value.IsString() ? std::string(value.GetString()) : std::string();
				bool active = value.IsBool() && value.GetBool();
				SKSE::GetTaskInterface()->AddTask([cb=done, gen=generation, msg, active]() { if(gen==epoch) cb(msg,active); });
			}
			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}
		};
		template<class... Args> bool Call(const char* fn, std::function<void(const std::string&,bool)> done, Args... args) {
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			auto* dh = RE::TESDataHandler::GetSingleton();
			// Stable quest identity verified in make_deck_esp.py; never create a new quest.
			auto* q = dh ? dh->LookupForm<RE::TESQuest>(0x802,"HotkeyDeckWardrobe.esp") : nullptr;
			if(!vm || !q || !q->IsRunning()) return false;
			auto* policy = vm->GetObjectHandlePolicy();
			auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE,q);
			if(handle==policy->EmptyHandle()) return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(new Reply(std::move(done)));
			return vm->DispatchMethodCall(handle,"HD_WardrobeExec",fn,RE::MakeFunctionArguments(std::move(args)...),cb);
		}
	}
	bool Edit(Wardrobe::Config& cfg, const json& edit, std::string& error) {
		try {
			auto doc = Wardrobe::ToJson(cfg);
			WardrobeFlairModel::Apply(doc,edit);
			Wardrobe::FromJson(doc,cfg);
			logger::info("wardrobe-flair: metadata edit {}",edit.value("type",std::string()));
			return true;
		} catch(const std::exception& e) { error=e.what(); return false; }
	}
	std::string DockJson(const Wardrobe::Config& cfg) {
		return Wardrobe::ToJson(cfg).dump(-1,' ',false,json::error_handler_t::replace);
	}
	bool DockEnabled(const Wardrobe::Config& cfg) {
		const auto d=cfg.flair.is_object()?cfg.flair.value("dock",json::object()):json::object();
		return !d.is_object() || !d.contains("enabled") || d["enabled"] != false;
	}
	void Equip(Wardrobe::Config& cfg, const std::string& request, Done done) {
		try {
			using WardrobeFlairModel::Need;
			Need(!busy,"An outfit change is still waiting for the game");
			Need(!OstimDeck::PlayerInScene(),"Finish the OStim scene before changing Flair");
			const auto req=json::parse(request);
			const auto kind=req.value("kind",std::string()), id=req.value("id",std::string());
			Need(kind=="clear" || kind=="flair" || kind=="outfit" || kind=="wardrobe","Unknown wardrobe action");
			auto f=WardrobeFlairModel::Flair(Wardrobe::ToJson(cfg));
			std::string base, flairId, label;
			std::vector<RE::TESObjectARMO*> armors;
			if(kind=="flair") flairId=id;
			else if(kind!="clear") {
				const auto linked=f["links"].value(kind+":"+id,std::string());
				// A portal edit between popup and E must require a fresh decision.
				Need(req.value("expectedFlairId",std::string())==linked,"Attached Flair changed. Reopen the dock and choose again");
				if(req.value("includeFlair",false)) flairId=linked;
				if(kind=="outfit") {
					Need(std::any_of(cfg.outfitMeta.begin(),cfg.outfitMeta.end(),[&](const auto& m){return m.name==id;}),"That outfit no longer exists in the wardrobe"); base=id;
				} else {
					Need(std::any_of(cfg.wardrobes.begin(),cfg.wardrobes.end(),[&](const auto& p){return p.id==id;}),"That wardrobe no longer exists");
					// Roll a copy until validation succeeds; do not burn the bag on a refused set.
					auto preview=cfg; base=Wardrobe::RollForDock(preview,id);
					Need(!base.empty(),"That wardrobe has no available outfits");
				}
			}
			if(!flairId.empty()) {
				const auto it=std::find_if(f["sets"].begin(),f["sets"].end(),[&](const auto& s){return s.value("id",std::string())==flairId;});
				Need(it!=f["sets"].end(),"That Flair set no longer exists"); label=it->value("name",std::string("Flair"));
				std::uint32_t occupied=0;
				for(const auto& p : it->at("items")) {
					auto* form=ActorIdentity::Resolve(p.value("formId",std::string()),p.value("plugin",std::string()));
					auto* armor=form?form->As<RE::TESObjectARMO>():nullptr;
					Need(armor!=nullptr,"A Flair accessory is missing from the load order; nothing was changed");
					const auto mask=static_cast<std::uint32_t>(armor->GetSlotMask());
					Need(mask!=0 && (occupied & mask)==0,"Two Flair accessories use the same equipment slot. Edit the set first");
					occupied|=mask; armors.push_back(armor);
				}
				Need(!armors.empty() && armors.size()<=32,"Choose 1 to 32 accessories");
			}
			if(kind=="wardrobe") base=Wardrobe::RollForDock(cfg,id);
			busy=true;
			auto complete=[done](const std::string& reply,bool) {
				busy=false; pulse=true; nextPulse=std::chrono::steady_clock::now()+std::chrono::seconds(2);
				const bool ok=reply.starts_with("OK|");
				std::string msg=reply.size()>3?reply.substr(reply.find('|')+1):"Wardrobe executor did not answer. Relaunch with the matched script and DLL";
				logger::info("wardrobe-flair: completed ok={} {}",ok,msg);
				done(Result(ok,msg));
			};
			const bool dispatched=kind=="clear" ? Call("ClearFlair",complete) :
				Call("WearFlair",complete,RE::BSFixedString(base.c_str()),RE::BSFixedString(label.c_str()),std::move(armors),f.value("keep",true));
			if(!dispatched) {busy=false;done(Result(false,"Wardrobe executor is unavailable; check HotkeyDeckWardrobe.esp"));}
			else logger::info("wardrobe-flair: ordered outfit + accessories queued");
		} catch(const std::exception& e) {done(Result(false,e.what()));}
	}
	void OnLoad() {++epoch;busy=false;pulse=true;resetOnPulse=true;nextPulse=std::chrono::steady_clock::now()+std::chrono::seconds(4);}
	void Tick(bool suspended) {
		const auto now=std::chrono::steady_clock::now();
		if(suspended || busy || !pulse || now<nextPulse) return;
		nextPulse=now+std::chrono::seconds(2); busy=true;
		const bool reset=resetOnPulse;
		if(!Call("FlairPulse",[](const std::string&,bool active){busy=false;pulse=active;resetOnPulse=false;},reset)) {busy=false;pulse=false;}
	}
}
