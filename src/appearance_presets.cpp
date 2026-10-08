#include "appearance_presets.h"
#include "appearance_model.h"
#include "console_actions.h"
#include "ostim_deck.h"
#include "portrait_capture.h"
#include "spell_actions.h"
#include "sos_actions.h"
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <fstream>
#include <optional>
#include <set>
#include <cmath>
#include <ctime>
#ifdef GetObject
#undef GetObject
#endif
#ifdef min
#undef min
#endif
#ifdef max
#undef max
#endif

namespace AppearancePresets
{
    namespace fs = std::filesystem;
    namespace {
        using AppearanceModel::Need;
        using Clock=std::chrono::steady_clock;
        using AV=RE::ActorValue;
        const fs::path kLibrary="Data/SKSE/Plugins/HotkeyDeck/appearances.json";
        const fs::path kSlots="Data/SKSE/Plugins/CharGen/Presets";
        fs::path view;
        std::atomic<bool> viewSet{false};   // `view` is final; other threads may read it
        json library=AppearanceModel::Empty(), undo, sosCatalog;
        std::string loadError, selected, message;
        std::string sosCatalogError;
        bool loaded=false, ready=false, lastOk=true;
        bool catalogBusy=false;
        Clock::time_point nextCatalog=Clock::now()+std::chrono::seconds(3);
        std::uint64_t serial=0;
        unsigned tickCount=0;
        std::uint64_t raceEvents=0;
        std::string session;
        std::function<void(bool)> portalClose;
        constexpr const char* kAlternative="ShowRaceMenuAlternative.esp";
        // Verified against the installed ESP, 2026-09-25. No mod script is copied.
        constexpr std::uint32_t kAlternativePower=0xD63, kAlternativeQuest=0xD62;

        const std::array<AV,23> progressAVs={AV::kOneHanded,AV::kTwoHanded,AV::kArchery,
            AV::kBlock,AV::kSmithing,AV::kHeavyArmor,AV::kLightArmor,AV::kPickpocket,
            AV::kLockpicking,AV::kSneak,AV::kAlchemy,AV::kSpeech,AV::kAlteration,
            AV::kConjuration,AV::kDestruction,AV::kIllusion,AV::kRestoration,
            AV::kEnchanting,AV::kHealth,AV::kMagicka,AV::kStamina,AV::kCarryWeight,AV::kDragonSouls};
        struct Progress {
            RE::PlayerCharacter::PlayerSkills::Data skills{};
            RE::TESNPC::Skills baseSkills{};
            std::array<float,23> values{};
            std::uint16_t level=0;
            std::uint16_t engineLevel=0;
            std::int8_t perkPoints=0;
            std::uint32_t trainings=0;
            std::vector<std::pair<RE::BGSPerk*,std::uint32_t>> perks;
        };
        struct Job {
            std::string op, phase, id, name, slot, failure;
            json target, backup;
            std::optional<Progress> progress;
            Done done;
            std::function<void(bool)> close;
            Clock::time_point started=Clock::now(), settle=Clock::now();
            bool changed=false, rollingBack=false, questSeen=false, menuSeen=false;
            bool takePortrait=false;
            std::uint64_t raceEventBefore=0;
        };
        std::optional<Job> job;

        class RaceEvents final:public RE::BSTEventSink<RE::TESSwitchRaceCompleteEvent> {
            RE::BSEventNotifyControl ProcessEvent(const RE::TESSwitchRaceCompleteEvent* ev,RE::BSTEventSource<RE::TESSwitchRaceCompleteEvent>*) override {
                if(ev && ev->subject.get()==RE::PlayerCharacter::GetSingleton()) ++raceEvents;
                return RE::BSEventNotifyControl::kContinue;
            }
        } raceSink;
        class MenuEvents final:public RE::BSTEventSink<RE::MenuOpenCloseEvent> {
            RE::BSEventNotifyControl ProcessEvent(const RE::MenuOpenCloseEvent* ev,RE::BSTEventSource<RE::MenuOpenCloseEvent>*) override {
                if(ev && ev->opening && ev->menuName==RE::RaceSexMenu::MENU_NAME) selected.clear();
                return RE::BSEventNotifyControl::kContinue;
            }
        } menuSink;

        std::string Stamp() {
            static unsigned counter=0;
            return std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count())+"-"+std::to_string(++counter);
        }
        std::string Dump(const json& d) {return d.dump(-1,' ',false,json::error_handler_t::replace);}
        std::string SavedSos(const json& row) {return Dump(row.value("sos",json()));}
        void Write(const fs::path& path,const json& data) {
            fs::create_directories(path.parent_path());
            const auto tmp=fs::path(path.wstring()+L".tmp");
            {std::ofstream f(tmp,std::ios::binary|std::ios::trunc); f<<Dump(data); f.flush(); Need(f.good(),"The appearance files could not be saved.");}
            Need(MoveFileExW(tmp.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)!=0,"The appearance library could not be replaced. Your previous library is intact.");
        }
        void Load() {
            if(loaded) return; loaded=true;
            try {
                if(fs::exists(kLibrary)) {std::ifstream f(kLibrary); f>>library; AppearanceModel::Validate(library);}
            } catch(const std::exception& e) {loadError=e.what();}
        }
        void Commit(json next) {
            Need(loadError.empty(),"The appearance library needs repair before it can be edited.");
            AppearanceModel::Validate(next);
            next["revision"]=library.value("revision",0)+1;
            if(fs::exists(kLibrary)) fs::copy_file(kLibrary,fs::path(kLibrary.wstring()+L".bak"),fs::copy_options::overwrite_existing);
            Write(kLibrary,next); library=std::move(next);
        }
        RE::PlayerCharacter* Player() {
            auto* p=RE::PlayerCharacter::GetSingleton();
            return ready && p && p->GetParentCell() ? p : nullptr;
        }
        RE::TESQuest* AlternativeQuest() {
            auto* dh=RE::TESDataHandler::GetSingleton();
            return dh ? dh->LookupForm<RE::TESQuest>(kAlternativeQuest,kAlternative) : nullptr;
        }
        bool AlternativeInstalled() {
            auto* dh=RE::TESDataHandler::GetSingleton();
            return dh && dh->LookupForm<RE::SpellItem>(kAlternativePower,kAlternative) && AlternativeQuest();
        }
        json RaceIdentity(RE::TESRace* race) {
            Need(race && race->GetFile(0),"This race has no stable plugin identity and cannot be saved.");
            const auto* file=race->GetFile(0);
            return {{"plugin",file->fileName},{"localId",race->GetLocalFormID()},
                {"editorId",race->GetFormEditorID() ? race->GetFormEditorID() : ""},
                {"name",race->GetName() ? race->GetName() : "Unknown race"}};
        }
        RE::TESRace* ResolveRace(const json& row) {
            const auto& r=row.at("race");
            auto* dh=RE::TESDataHandler::GetSingleton();
            auto* race=dh ? dh->LookupForm<RE::TESRace>(r.value("localId",0u),r.value("plugin",std::string())) : nullptr;
            if(!race) return nullptr;
            // Never accept a real but wrong record after compaction/reindexing.
            const auto edid=r.value("editorId",std::string());
            if(!edid.empty() && edid!=(race->GetFormEditorID() ? race->GetFormEditorID() : "")) return nullptr;
            return race;
        }
        json ReadSlot(const std::string& slot) {
            Need(AppearanceModel::Id(slot),"Invalid appearance file.");
            const auto path=kSlots/(slot+".jslot");
            Need(fs::is_regular_file(path) && fs::file_size(path)<16*1024*1024,"The saved appearance file is missing or too large.");
            std::ifstream f(path); json j; f>>j;
            Need(j.is_object() && j.contains("headParts") && j.contains("morphs") && j.contains("actor"),"RaceMenu did not produce a complete appearance file.");
            return j;
        }
        void Dependencies(const json& row) {
            Need(ResolveRace(row)!=nullptr,"The race for this look is unavailable. Enable its mod before switching.");
            const auto sosProblem=SosActions::AppearanceProblem(SavedSos(row));
            Need(sosProblem.empty(),sosProblem.c_str());
            const auto j=ReadSlot(row.at("slot")); auto* dh=RE::TESDataHandler::GetSingleton();
            std::set<std::string> plugins;
            if(j.contains("modNames") && j["modNames"].is_array()) for(const auto& n:j["modNames"]) if(n.is_string()) plugins.insert(n.get<std::string>());
            if(j.contains("mods") && j["mods"].is_array()) for(const auto& n:j["mods"]) if(n.is_object()) plugins.insert(n.value("name",std::string()));
            for(const auto& name:plugins) if(!name.empty()) Need(dh && dh->LookupModByName(name),"A mod used by this look is unavailable. Restore its face and hair mods before switching.");
        }
        void CanChange() {
            auto* p=Player(); Need(p && p->Is3DLoaded(),"Load a save and wait for your character to appear.");
            Need(GetModuleHandleW(L"skee64.dll")!=nullptr,"RaceMenu is required to save and switch looks.");
            auto* dh=RE::TESDataHandler::GetSingleton();
            Need(dh && dh->LookupForm<RE::BGSColorForm>(0x801,"RaceMenu.esp"),"Enable RaceMenu.esp before saving or switching looks.");
            Need(!p->IsDead() && !p->IsInCombat() && !p->IsInKillMove(),"Finish combat before changing your appearance.");
            Need(!OstimDeck::PlayerInScene(),"Finish the current scene before changing your appearance.");
            Need(!RE::UI::GetSingleton()->IsMenuOpen(RE::RaceSexMenu::MENU_NAME),"Finish your current customization first.");
            Need(!PortraitCapture::SelfPortraitArmed() && !PortraitCapture::SelfCaptureBusy(),"Finish or cancel your photograph first.");
            auto* race=p->GetRace();
            Need(race && race->GetPlayable(),"Return to your normal playable form before using appearance presets.");
            auto* q=AlternativeQuest(); Need(!q || !q->IsRunning(),"Finish your current customization first.");
        }
        Progress CaptureProgress() {
            auto* p=Player(); Need(p && p->GetInfoRuntimeData().skills && p->GetInfoRuntimeData().skills->data,"Your skill progress is not available yet.");
            Progress out; out.skills=*p->GetInfoRuntimeData().skills->data;
            out.baseSkills=p->GetActorBase()->playerSkills; out.level=p->GetActorBase()->actorData.level;
            out.engineLevel=p->GetLevel();
            out.perkPoints=p->GetGameStatsData().perkCount;
            out.trainings=p->GetInfoRuntimeData().skillTrainingsThisLevel;
            for(std::size_t i=0;i<progressAVs.size();++i) out.values[i]=p->AsActorValueOwner()->GetBaseActorValue(progressAVs[i]);
            // The player's acquired-perk collection, not every race/standing-
            // stone ability. Those remain the owning mod's responsibility.
            for(auto* data:p->GetPlayerRuntimeData().addedPerks) if(data && data->perk) out.perks.emplace_back(data->perk,static_cast<std::uint32_t>(std::max(0,static_cast<int>(data->currentRank))));
            return out;
        }
        std::optional<std::uint32_t> AcquiredRank(RE::PlayerCharacter* p,RE::BGSPerk* perk) {
            for(auto* data:p->GetPlayerRuntimeData().addedPerks)
                if(data && data->perk==perk) return static_cast<std::uint32_t>(std::max(0,static_cast<int>(data->currentRank)));
            return std::nullopt;
        }
        bool RestoreProgress(const Progress& before) {
            auto* p=Player(); if(!p || !p->GetInfoRuntimeData().skills || !p->GetInfoRuntimeData().skills->data) return false;
            auto* base=p->GetActorBase();
            if(p->GetLevel()!=before.engineLevel) ConsoleActions::Fire("Restore appearance progress","player.setlevel "+std::to_string(before.engineLevel),false);
            base->playerSkills=before.baseSkills; base->actorData.level=before.level;
            base->AddChange(RE::TESNPC::ChangeFlags::kNPCSkills|RE::TESNPC::ChangeFlags::kBaseData);
            auto* owner=p->AsActorValueOwner();
            for(std::size_t i=0;i<progressAVs.size();++i) owner->SetBaseActorValue(progressAVs[i],before.values[i]);
            *p->GetInfoRuntimeData().skills->data=before.skills;
            p->GetInfoRuntimeData().skillTrainingsThisLevel=before.trainings;
            for(const auto& [perk,rank]:before.perks) if(AcquiredRank(p,perk)!=rank) p->AddPerk(perk,rank);
            p->GetGameStatsData().perkCount=before.perkPoints;
            bool ok=p->GetLevel()==before.engineLevel && p->GetActorBase()->actorData.level==before.level && p->GetGameStatsData().perkCount==before.perkPoints;
            const auto& actual=*p->GetInfoRuntimeData().skills->data;
            ok=ok && actual.xp==before.skills.xp && actual.levelThreshold==before.skills.levelThreshold;
            for(std::size_t i=0;i<18;++i) ok=ok && actual.skills[i].level==before.skills.skills[i].level && actual.skills[i].xp==before.skills.skills[i].xp && actual.skills[i].levelThreshold==before.skills.skills[i].levelThreshold && actual.legendaryLevels[i]==before.skills.legendaryLevels[i];
            for(std::size_t i=0;i<progressAVs.size();++i) ok=ok && std::abs(owner->GetBaseActorValue(progressAVs[i])-before.values[i])<0.01f;
            for(const auto& [perk,rank]:before.perks) ok=ok && p->HasPerk(perk) && AcquiredRank(p,perk)==rank;
            logger::info("appearance-progress: restored and verified={} level={} xp={}",ok,before.engineLevel,before.skills.xp);
            return ok;
        }
        json CurrentLook(const std::string& slot,const std::string& name) {
            auto* p=Player(); Need(p!=nullptr,"No character is loaded.");
            return {{"id","look-"+Stamp()},{"name",name},{"slot",slot},{"race",RaceIdentity(p->GetRace())},
                {"sex",p->GetActorBase()->IsFemale()?1:0},{"portrait",""},{"createdAt",std::time(nullptr)}};
        }
        void Publish();
        void Finish(bool ok,const std::string& msg) {
            auto done=job ? job->done : Done{};
            const auto id=job ? job->id : std::string();
            job.reset(); ++serial; message=msg; lastOk=ok;
            logger::info("appearance-presets: completed ok={} {}",ok,msg);
            RE::DebugNotification(msg.c_str()); Publish();
            if(done) done({{"ok",ok},{"msg",msg},{"id",id},{"data",State()}});
        }
        class Reply final:public RE::BSScript::IStackCallbackFunctor {
            std::uint64_t generation; std::function<void(bool)> then;
        public:
            explicit Reply(std::function<void(bool)> cb):generation(serial),then(std::move(cb)){}
            void operator()(RE::BSScript::Variable result) override {
                const bool ok=!result.IsBool() || result.GetBool();
                SKSE::GetTaskInterface()->AddTask([g=generation,cb=then,ok](){if(g==serial && job) cb(ok);});
            }
            bool CanSave() const override{return false;}
            void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override{}
        };
        template<class...Args> bool Call(const char* script,const char* fn,std::function<void(bool)> done,Args...args) {
            auto* vm=RE::BSScript::Internal::VirtualMachine::GetSingleton(); if(!vm) return false;
            RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(new Reply(std::move(done)));
            return vm->DispatchStaticCall(script,fn,RE::MakeFunctionArguments(std::move(args)...),cb);
        }
        bool SetRace(RE::TESRace* race,std::function<void(bool)> done) {
            auto* p=Player(); auto* vm=RE::BSScript::Internal::VirtualMachine::GetSingleton(); if(!p || !vm) return false;
            auto* policy=vm->GetObjectHandlePolicy();
            auto handle=policy->GetHandleForObject(RE::Actor::FORMTYPE,p);
            RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(new Reply(std::move(done)));
            return vm->DispatchMethodCall(handle,"Actor","SetRace",RE::MakeFunctionArguments(std::move(race)),cb);
        }
        void Backout(const std::string& why);
        void ApplyTarget();
        SosActions::AppearanceAlive SosAlive() {
            const auto generation=serial;
            return [generation](){return generation==serial && job.has_value() && Player()!=nullptr;};
        }
        void CaptureSos(bool backup,std::function<void()> then) {
            if(!job)return;
            job->phase="Saving SOS settings";
            SosActions::CaptureAppearance([backup,then](std::string result){
                try {
                    const auto r=json::parse(result);
                    Need(r.value("ok",false),r.value("msg",std::string("SOS could not save this look's settings.")).c_str());
                    (backup?job->backup:job->target)["sos"]=r.at("state");
                    then();
                }catch(const std::exception& e){Backout(e.what());}
            },SosAlive());
        }
        void RestoreSos() {
            if(!job)return;
            job->phase="Restoring SOS type and size";
            SosActions::ApplyAppearance(SavedSos(job->target),[](std::string result){
                try {
                    const auto r=json::parse(result);
                    if(!r.value("ok",false)){Backout(r.value("msg",std::string("SOS could not restore this look.")));return;}
                    job->phase="Checking appearance and progress";
                    job->settle=Clock::now()+std::chrono::milliseconds(1500);
                }catch(const std::exception& e){Backout(e.what());}
            },SosAlive());
        }
        void CompleteSwitch() {
            if(!job)return;
            auto* p=Player();
            const bool right=p && p->GetRace()==ResolveRace(job->target) && p->GetActorBase()->IsFemale()==(job->target.value("sex",0)==1);
            if(!right){Backout("Skyrim did not retain the requested appearance.");return;}
            job->phase="Verifying saved SOS settings";
            SosActions::VerifyAppearance(SavedSos(job->target),[](std::string result){
                try {
                    const auto r=json::parse(result);
                    if(!r.value("ok",false)){Backout(r.value("msg",std::string("SOS settings changed before the switch finished.")));return;}
                    if(!job->progress || !RestoreProgress(*job->progress)){Backout("The progress check did not pass.");return;}
                    if(job->rollingBack){selected.clear();Finish(false,job->failure+" Your previous look, SOS settings and progress were restored.");return;}
                    undo=job->backup;selected=job->id;
                    const bool sos=SosAppearanceModel::Managed(job->target.value("sos",json()));
                    Finish(true,sos?"Look and SOS settings switched. Your current progress was kept.":"Look switched. Your current progress was kept. This look has no saved SOS settings.");
                }catch(const std::exception& e){Backout(e.what());}
            },SosAlive());
        }
        void LoadTarget() {
            auto* p=Player(); if(!p || !job) return;
            if(p->GetActorBase()->race!=ResolveRace(job->target)){Backout("The player base race did not finish updating.");return;}
            job->phase="Applying saved appearance";
            // RaceMenu 0.4.16 adds saved skin overrides without clearing the old
            // skin. Explicitly remove them before the full preset is reapplied.
            const bool accepted=Call("NiOverride","RemoveAllReferenceSkinOverrides",[](bool){
                auto* p=Player(); if(!job || !p) return;
                auto* dh=RE::TESDataHandler::GetSingleton();
                // CharGen.psc identifies RaceMenu's dedicated mutable hair color.
                auto* color=dh ? dh->LookupForm<RE::BGSColorForm>(0x801,"RaceMenu.esp") : nullptr;
                const auto slot=job->target.value("slot",std::string());
                if(!Call("CharGen","LoadCharacterPresetEx",[](bool ok){
                    if(!ok){Backout("RaceMenu could not apply this look.");return;}
                    // RaceMenu first restores saved morphs/node transforms. SOS
                    // then restores its add-on and size; when SOSRaceMenu owns
                    // player size, its own API deliberately skips bone scaling.
                    RestoreSos();
                },static_cast<RE::Actor*>(p),RE::BSFixedString(slot),color,std::int32_t(15))) Backout("RaceMenu did not accept the appearance request.");
            },static_cast<RE::TESObjectREFR*>(p));
            if(!accepted) Backout("RaceMenu's skin restoration function is unavailable.");
        }
        void ApplyTarget() {
            if(!job) return;
            auto* p=Player(); auto* race=ResolveRace(job->target);
            if(!p || !race){Backout("The saved race is no longer available.");return;}
            const bool female=job->target.value("sex",0)==1;
            job->changed=true;
            if(p->GetActorBase()->IsFemale()!=female) {
                // Fixed command through the existing engine verb. No user text
                // reaches the console; the result is checked before continuing.
                ConsoleActions::Fire("Appearance sex","player.sexchange",false);
                if(p->GetActorBase()->IsFemale()!=female){Backout("Skyrim could not change this look's sex.");return;}
            }
            if(p->GetRace()==race) {LoadTarget();return;}
            job->phase="Changing race";
            job->raceEventBefore=raceEvents;
            if(!SetRace(race,[](bool){
                if(!job) return;
                job->phase="Waiting for race to settle";
                job->settle=Clock::now()+std::chrono::milliseconds(1000);
            })) Backout("Skyrim did not accept the race change.");
        }
        void Backout(const std::string& why) {
            if(!job) return;
            if(job->rollingBack) {
                if(job->progress) RestoreProgress(*job->progress);
                Finish(false,"Appearance recovery could not finish. Reload your last save. "+why);return;
            }
            if(!job->changed) {Finish(false,why);return;}
            job->rollingBack=true; job->failure=why; job->target=job->backup;
            job->phase="Restoring your previous look";
            logger::warn("appearance-presets: rollback {}",why);
            ApplyTarget();
        }
        void SaveSlot(const std::string& slot,std::function<void(bool)> done) {
            auto* p=Player(); fs::create_directories(kSlots);
            if(!Call("CharGen","SaveCharacterPreset",[slot,done](bool){
                try {ReadSlot(slot);done(true);} catch(const std::exception& e) {logger::error("appearance-presets: save verification {}",e.what());done(false);}
            },static_cast<RE::Actor*>(p),RE::BSFixedString(slot))) done(false);
        }
        void StartSwitch(const json& target,Done done,std::function<void(bool)> close) {
            CanChange(); Dependencies(target);
            Job next; next.op="switch"; next.id=target.value("id",std::string()); next.target=target;
            next.progress=CaptureProgress(); next.done=std::move(done); next.close=std::move(close);
            next.phase="Saving a recovery look";
            next.backup=CurrentLook("sm-recovery-"+Stamp(),"Previous look");
            job=std::move(next); ++serial;
            job->close(false);
            auto* race=ResolveRace(job->target);
            job->phase="Checking SOS compatibility";
            SosActions::ValidateAppearance(SavedSos(job->target),race->GetFormID(),job->target.value("sex",0)==1,[](std::string result){
                try {
                    const auto r=json::parse(result);
                    Need(r.value("ok",false),r.value("msg",std::string("SOS compatibility could not be checked.")).c_str());
                    CaptureSos(true,[](){
                        SaveSlot(job->backup.at("slot"),[](bool ok){
                            if(!ok){Finish(false,"Could not save a recovery look. Your appearance was not changed.");return;}
                            try {Dependencies(job->backup);ApplyTarget();}catch(const std::exception& e){Finish(false,e.what());}
                        });
                    });
                }catch(const std::exception& e){Finish(false,e.what());}
            },SosAlive());
        }
        std::string QuickTarget(bool normal=false) {
            const auto n=library.value("normalId",std::string()),q=library.value("quickId",std::string());
            bool wearing=false;auto* p=Player();
            if(p && !n.empty() && !q.empty()) {
                const auto& nr=AppearanceModel::Find(library,n);const auto& qr=AppearanceModel::Find(library,q);
                wearing=p->GetRace()==ResolveRace(qr) && p->GetActorBase()->IsFemale()==(qr.value("sex",0)==1) &&
                    (ResolveRace(qr)!=ResolveRace(nr) || qr.value("sex",0)!=nr.value("sex",0));
            }
            return AppearanceModel::QuickTarget(library,selected,wearing,normal);
        }
        json SosOptions(const json& row) {
            Need(!sosCatalog.is_null(),sosCatalogError.empty()?"Let gameplay run briefly while SOS loads its add-ons, then reopen Manage.":sosCatalogError.c_str());
            auto* race=ResolveRace(row);Need(race!=nullptr,"The race for this look is unavailable.");
            return {{"sizeSource",sosCatalog.value("sizeSource",std::string())},
                {"choices",SosAppearanceModel::Choices(sosCatalog,RaceIdentity(race),row.value("sex",0)==1)}};
        }
        void ArmPortrait(const json& row,bool saved=false) {
            const auto id=row.value("id",std::string());
            job->op="portrait";job->id=id;job->phase="Frame your portrait and press Enter";
            const auto generation=serial;const auto dir=view/"portraits"/("looks-"+id);fs::create_directories(dir);
            // Private destination: another look's or the sheet's photo cannot be pruned.
            if(fs::exists(view/"portraits/capture.ini"))fs::copy_file(view/"portraits/capture.ini",dir/"capture.ini",fs::copy_options::overwrite_existing);
            job->close(true);
            if(saved)RE::DebugNotification("Look saved. Frame your portrait and press Enter; Escape skips the photo.");
            PortraitCapture::ArmPlayerSheet(dir,[generation,id,saved](const std::string& file){
                if(generation!=serial || !job)return;
                if(file.empty()){Finish(saved,saved?"Look saved. Portrait could not be captured; you can retake it later.":"Portrait could not be captured. Your previous portrait is unchanged.");return;}
                try {auto next=library;AppearanceModel::Find(next,id)["portrait"]="portraits/looks-"+id+"/"+file;Commit(next);Finish(true,saved?"Look and portrait saved.":"Portrait saved for this look.");}
                catch(const std::exception& e){Finish(false,e.what());}
            },[generation,saved](){if(generation==serial && job)Finish(saved,saved?"Look saved. Portrait skipped; you can take it later.":"Portrait cancelled. Your previous portrait is unchanged.");});
        }
        // SMOOTHNESS (2026-10-07, marker "appearance-status-async"): Publish runs
        // on the game thread every 5 s, and used to serialise the whole library
        // AND write it through to disk (MOVEFILE_WRITE_THROUGH, on the MO2 VFS)
        // right there -- part of the 4-9 ms "desync-watchdog" spikes in the perf
        // census. State() needs the player, so it is still built here; the dump
        // and the disk work go to one writer thread. Latest wins: a newer status
        // replaces an unwritten older one, so the file can never go backwards.
        // No write-through: the file is rewritten every 5 s and the phone treats
        // anything older than 15 s as offline, so a lost write costs nothing.
        std::mutex statusMtx;
        std::condition_variable statusCv;
        std::optional<json> statusPending;
        bool statusWriter=false;
        void StatusWriterLoop(fs::path path) {
            for(;;) {
                json next;
                {
                    std::unique_lock l(statusMtx);
                    statusCv.wait(l,[]{return statusPending.has_value();});
                    next=std::move(*statusPending); statusPending.reset();
                }
                try {
                    const auto tmp=fs::path(path.wstring()+L".tmp");
                    {std::ofstream f(tmp,std::ios::binary|std::ios::trunc); f<<Dump(next); if(!f.good()) throw std::runtime_error("could not write the status file");}
                    if(!MoveFileExW(tmp.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING)) throw std::runtime_error("could not replace the status file");
                } catch(const std::exception& e){logger::warn("appearance-presets: status {}",e.what());}
            }
        }
        void Publish() {
            if(view.empty()) return;
            json state;
            try {state=State();} catch(const std::exception& e){logger::warn("appearance-presets: status {}",e.what());return;}
            std::lock_guard l(statusMtx);
            statusPending=std::move(state);
            if(!statusWriter) {
                statusWriter=true;
                std::thread(StatusWriterLoop,view/"appearances-status.json").detach();
                logger::info("appearance-status-async: status writer off the game thread");
            }
            statusCv.notify_one();
        }
    }

    void Init(const fs::path& dir,std::function<void(bool)> close) {
        view=dir; viewSet.store(true,std::memory_order_release); portalClose=std::move(close); session=Stamp(); Load();
        if(auto* events=RE::ScriptEventSourceHolder::GetSingleton()) events->AddEventSink(&raceSink);
        if(auto* ui=RE::UI::GetSingleton()) ui->AddEventSink(&menuSink);
        fs::create_directories(view/"appearance-requests"); fs::create_directories(view/"appearance-results");
        logger::info("appearance-presets: portrait gallery and progress checkpoint ready");
        logger::info("appearance-sos: per-look addon and size recovery ready");
        logger::info("appearance-workflow: session recovery protected forms sos editor and guided portraits ready");
    }
    json State() {
        Load(); auto* p=Player();
        json out={{"ok",loadError.empty()},{"msg",loadError.empty()?message:loadError},{"lastOk",lastOk},
            {"looks",loadError.empty()?library["looks"]:json::array()},{"selectedId",selected},
            {"busy",job.has_value()},{"phase",job?job->phase:""},{"undo",!undo.is_null()},
            {"online",p!=nullptr},{"session",session},{"raceMenu",GetModuleHandleW(L"skee64.dll")!=nullptr},
            {"customizeAvailable",AlternativeInstalled()},{"at",std::time(nullptr)},
            {"currentRace",p && p->GetRace()?p->GetRace()->GetName():""}};
        out["revision"]=library.value("revision",0);
        out["normalId"]=library.value("normalId",std::string());out["quickId"]=library.value("quickId",std::string());
        out["sosEditorReady"]=!sosCatalog.is_null();
        out["nextQuickId"]="";
        if(loadError.empty())try{out["nextQuickId"]=QuickTarget();}catch(const std::exception&){}
        if(loadError.empty()) for(auto& row:out["looks"]) {
            row["available"]=ResolveRace(row)!=nullptr && fs::exists(kSlots/(row.value("slot",std::string())+".jslot"));
            const auto sosProblem=SosActions::AppearanceProblem(SavedSos(row));
            if(!sosProblem.empty()){row["available"]=false;row["availableReason"]=sosProblem;}
            const auto path=row.value("portrait",std::string());
            if(!path.empty() && !AppearanceModel::Portrait(path,row.value("id",std::string()))) row["portrait"]="";
        }
        return out;
    }
    void Handle(const json& req,Done done,std::function<void(bool)> close) {
        Load();
        const auto initialSerial=serial;
        const auto clientId=req.is_object() && req.contains("clientRequestId") && req["clientRequestId"].is_string()?req["clientRequestId"].get<std::string>():std::string();
        const auto requestSession=req.is_object() && req.contains("session") && req["session"].is_string()?req["session"].get<std::string>():session;
        done=[reply=std::move(done),clientId,requestSession](const json& result){auto out=result;out["clientRequestId"]=clientId;out["requestSession"]=requestSession;reply(out);};
        try {
            Need(req.is_object(),"Invalid appearance request.");
            const auto op=req.value("op",std::string());
            if(op=="get") {done({{"ok",true},{"data",State()}});return;}
            Need(clientId.empty() || AppearanceModel::Id(clientId),"Invalid appearance request identity.");
            Need(requestSession==session,"The loaded save changed. Refresh Appearances and try again.");
            Need(!job,"An appearance change is still in progress.");
            Need(loadError.empty(),"The appearance library could not be read. It has not been changed.");
            if(op=="role") {
                auto next=library;AppearanceModel::SetRole(next,req);Commit(next);
                done({{"ok",true},{"msg","Appearance shortcuts updated."},{"data",State()}});Publish();return;
            }
            if(op=="sos-options") {
                const auto& row=AppearanceModel::Find(library,req.value("id",std::string()));AppearanceModel::Expected(row,req);
                done({{"ok",true},{"options",SosOptions(row)},{"data",State()}});return;
            }
            if(op=="sos-save") {
                CanChange();auto row=AppearanceModel::Find(library,req.value("id",std::string()));AppearanceModel::Expected(row,req);
                AppearanceModel::Editable(library,row.at("id"));
                row["sos"]=SosAppearanceModel::Edit(row.value("sos",json()),SosOptions(row),req);
                Job next;next.op=op;next.id=row.at("id");next.target=row;next.done=done;next.close=close;next.phase="Checking saved SOS settings";
                job=std::move(next);++serial;job->close(false);
                SosActions::ValidateAppearance(SavedSos(row),ResolveRace(row)->GetFormID(),row.value("sex",0)==1,[req](std::string result){
                    try {
                        const auto r=json::parse(result);Need(r.value("ok",false),r.value("msg",std::string("SOS settings could not be checked.")).c_str());
                        auto next=library;auto& target=AppearanceModel::Find(next,job->id);AppearanceModel::Expected(target,req);AppearanceModel::Editable(next,job->id);
                        target["sos"]=job->target.at("sos");target["revision"]=target.value("revision",0)+1;
                        Commit(next);if(selected==job->id)selected.clear();
                        Finish(true,"SOS settings saved for this look. Apply it to see the change; retake its portrait when ready.");
                    }catch(const std::exception& e){Finish(false,e.what());}
                },SosAlive());return;
            }
            if(op=="rename" || op=="delete") {
                auto next=library; auto id=req.value("id",std::string());auto& row=AppearanceModel::Find(next,id); AppearanceModel::Expected(row,req);
                if(op=="rename") row["name"]=AppearanceModel::Name(req);
                else {AppearanceModel::Editable(next,id);Need(req.value("confirm",false),"Confirm removal of this saved look."); auto& rows=next["looks"];rows.erase(std::remove_if(rows.begin(),rows.end(),[&](const auto& r){return r.value("id",std::string())==id;}),rows.end());if(next.value("quickId",std::string())==id)next["quickId"]="";}
                Commit(next); if(op=="delete" && selected==id) selected.clear();
                done({{"ok",true},{"msg",op=="rename"?"Look renamed.":"Look removed from your library."},{"data",State()}});Publish();return;
            }
            if(op=="switch" || op=="undo" || op=="quick" || op=="normal") {
                if(op=="quick") {
                    const auto nextId=QuickTarget();(void)nextId;
                    Dependencies(AppearanceModel::Find(library,library.value("normalId",std::string())));
                    Dependencies(AppearanceModel::Find(library,library.value("quickId",std::string())));
                }
                auto target=op=="undo"?undo:AppearanceModel::Find(library,(op=="quick" || op=="normal")?QuickTarget(op=="normal"):req.value("id",std::string()));
                Need(!target.is_null(),"There is no previous look to restore in this game session.");
                if(op=="switch") AppearanceModel::Expected(target,req);
                StartSwitch(target,done,close);return;
            }
            if(op=="save" || op=="replace") {
                CanChange(); const auto name=AppearanceModel::Name(req);
                std::string id;
                if(op=="replace") {auto& row=AppearanceModel::Find(library,req.value("id",std::string()));AppearanceModel::Expected(row,req);AppearanceModel::Editable(library,row.at("id"));Need(req.value("confirm",false),"Confirm replacement of this look.");id=row.at("id");}
                else Need(library["looks"].size()<500,"Your appearance library is full.");
                Job next; next.op=op;next.name=name;next.id=id;next.slot="sm-look-"+Stamp();next.phase="Saving your current look";next.done=done;next.close=close;
                next.target=CurrentLook(next.slot,name);if(!id.empty()) next.target["id"]=id;job=std::move(next);++serial;
                job->takePortrait=req.value("takePortrait",false);
                // Papyrus must run: hide/unpause the palette for this short job.
                job->close(false);
                CaptureSos(false,[](){SaveSlot(job->slot,[](bool ok){
                    if(!ok){Finish(false,"RaceMenu could not save the look. Your library is unchanged.");return;}
                    try {
                        auto next=library;auto row=job->target;
                        if(job->op=="replace") {auto& old=AppearanceModel::Find(next,job->id);row["portrait"]="";row["revision"]=old.value("revision",0)+1;old.update(row);row=old;}
                        else next["looks"].push_back(row);
                        Commit(next); selected=row.at("id");job->id=selected;
                        if(job->takePortrait){
                            try{ArmPortrait(row,true);}catch(const std::exception& e){Finish(true,std::string("Look saved. The portrait could not start: ")+e.what());}
                            return;
                        }
                        Finish(true,SosAppearanceModel::Managed(row.value("sos",json()))?"Look and SOS settings saved. Open Appearances to take its portrait.":"Look saved. SOS is not installed, so no SOS settings were recorded.");
                    }catch(const std::exception& e){Finish(false,e.what());}
                });});return;
            }
            if(op=="customize") {
                CanChange();Need(AlternativeInstalled(),"Install and enable ShowRaceMenu Alternative to customize safely.");
                Job next;next.op=op;next.phase="Opening customization";next.done=done;next.close=close;next.progress=CaptureProgress();
                next.backup=CurrentLook("sm-recovery-"+Stamp(),"Before customization"); job=std::move(next);++serial;job->close(false);
                CaptureSos(true,[](){SaveSlot(job->backup.at("slot"),[](bool ok){
                    if(!ok){Finish(false,"Could not save a recovery look. Customization was not opened.");return;}
                    job->phase="Customize your character in RaceMenu";
                    const auto result=json::parse(SpellActions::Cast(kAlternative,kAlternativePower,0));
                    if(!result.value("ok",false)) Finish(false,result.value("msg",std::string("Could not open customization.")));
                });});return;
            }
            if(op=="portrait") {
                CanChange();auto& row=AppearanceModel::Find(library,req.value("id",std::string()));AppearanceModel::Expected(row,req);
                Need(selected==row.value("id",std::string()),"Switch to this look before taking its portrait.");
                Need(Player()->GetRace()==ResolveRace(row) && Player()->GetActorBase()->IsFemale()==(row.value("sex",0)==1),"Your appearance changed. Save it or switch back to this look before taking its portrait.");
                Job next;next.op=op;next.done=done;next.close=close;job=std::move(next);++serial;ArmPortrait(row);return;
            }
            throw std::runtime_error("Unknown appearance action.");
        }catch(const std::exception& e){
            if(job && serial!=initialSerial) {
                if(job->changed) Backout(e.what());
                else Finish(false,e.what());
            }
            else done({{"ok",false},{"msg",e.what()},{"data",State()}});
        }
    }
    bool RequestsPending() {
        if(!viewSet.load(std::memory_order_acquire)) return false;
        std::error_code ec;
        for(fs::directory_iterator it(view/"appearance-requests",ec),end; !ec && it!=end; it.increment(ec))
            if(it->path().extension()==L".json") return true;
        return false;
    }
    void Tick(bool gameReady, bool requestsPending) {
        ready=gameReady;
        if(!ready) return;
        // Papyrus reads cannot finish behind the paused gallery. Warm only the
        // small registered SOS catalogue during gameplay; each write also gets
        // a fresh live compatibility check after the palette closes.
        if(!job && !catalogBusy && Clock::now()>=nextCatalog && RE::UI::GetSingleton() && !RE::UI::GetSingleton()->GameIsPaused()) {
            catalogBusy=true;const auto generation=session;nextCatalog=Clock::now()+std::chrono::seconds(60);
            SosActions::ReadAppearanceCatalog([generation](std::string result){
                if(generation!=session)return;catalogBusy=false;
                try {const auto r=json::parse(result);if(r.value("ok",false)){sosCatalog=r.at("state");sosCatalogError.clear();}
                    else {sosCatalog=nullptr;sosCatalogError=r.value("msg",std::string("SOS add-ons are not ready."));nextCatalog=Clock::now()+std::chrono::seconds(10);}}
                catch(const std::exception& e){sosCatalog=nullptr;sosCatalogError=e.what();}
            },[generation](){return generation==session && ready;});
        }
        if(job) {
            if(job->phase=="Waiting for race to settle" && Clock::now()>=job->settle) {
                auto* p=Player();
                if(!p || p->GetRace()!=ResolveRace(job->target)){Backout("The race change did not finish as requested.");}
                else if(p->Is3DLoaded() && raceEvents>job->raceEventBefore) LoadTarget();
            } else if(job->phase=="Checking appearance and progress" && Clock::now()>=job->settle) {
                CompleteSwitch();
            } else if(job->op=="customize" && job->phase=="Customize your character in RaceMenu") {
                auto* q=AlternativeQuest();auto* ui=RE::UI::GetSingleton();
                if(q && q->IsRunning()) job->questSeen=true;
                if(ui && ui->IsMenuOpen(RE::RaceSexMenu::MENU_NAME)){job->menuSeen=true;selected.clear();}
                if(job->questSeen && q && !q->IsRunning()) {
                    const bool ok=job->progress && RestoreProgress(*job->progress);
                    undo=job->backup;
                    Finish(ok,ok?"Customization finished. Save your new look in Appearances.":"The progress check did not pass. Reload your last save before continuing.");
                } else if(!job->questSeen && Clock::now()-job->started>std::chrono::seconds(30) && ui && !ui->GameIsPaused()) {
                    Finish(false,"Customization was cancelled or did not open. Your saved looks are unchanged.");
                }
            }
        }
        if(++tickCount%5==0) Publish();
        // One-use, short-lived phone commands. Claim by rename before dispatch;
        // a restart cannot silently replay a character transformation later.
        // The worker thread that posted this tick already looked (RequestsPending),
        // so the common empty case walks no directory on the game thread.
        if(!requestsPending) return;
        try {
            if(!view.empty()) for(const auto& entry:fs::directory_iterator(view/"appearance-requests")) {
                if(entry.path().extension()!=L".json") continue;
                const auto id=PathU8(entry.path().stem());if(!AppearanceModel::Id(id))continue;
                const auto claimed=fs::path(entry.path().wstring()+L".processing");fs::rename(entry.path(),claimed);
                json req; {std::ifstream f(claimed);f>>req;}
                auto reply=[id,claimed](const json& result){
                    try {auto out=result;out["requestId"]=id;Write(view/"appearance-results"/(id+".json"),out);fs::remove(claimed);}catch(const std::exception& e){logger::warn("appearance-presets: phone result {}",e.what());}
                };
                if(req.value("session",std::string())!=session || std::time(nullptr)-req.value("at",std::int64_t(0))>20 || req.value("at",std::int64_t(0))>std::time(nullptr)+5) reply({{"ok",false},{"msg","This request expired. Refresh the gallery and try again."}});
                else Handle(req,reply,portalClose);
                break;
            }
        }catch(const std::exception& e){logger::warn("appearance-presets: phone queue {}",e.what());}
    }
    void ResetForLoad() {
        auto done=job?job->done:Done{};
        ++serial;session=Stamp();job.reset();undo=nullptr;selected.clear();ready=false;message.clear();
        sosCatalog=nullptr;sosCatalogError.clear();catalogBusy=false;nextCatalog=Clock::now()+std::chrono::seconds(3);
        // Never restore a checkpoint into a different save/character. Late VM
        // callbacks are ignored by the generation check.
        if(done)done({{"ok",false},{"cancelled",true},{"session",session},{"msg","The loaded save changed. The previous appearance action was cancelled."}});
    }
}
