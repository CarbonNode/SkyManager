#pragma once

#include "json.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <map>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

// Pure scene metadata parsing, classification and index validation. No engine,
// filesystem or logger dependencies: the game and portable tests use this code.
namespace SceneTagsModel
{
    using json = nlohmann::json;
    inline constexpr int kCacheVersion = 3;
    inline constexpr std::array<std::string_view, 24> kKnownIcons = {
        "carry", "cowgirl", "cowgirl-lean", "doggy", "embrace", "footjob", "group",
        "handjob", "kneel", "legsup", "lotus", "missionary", "oral", "prone",
        "sixtynine", "solo", "spooning", "standing", "titjob", "transition",
        "face-sitting", "bent-over-table", "wall-behind", "wheelbarrow"
    };

    inline bool KnownIcon(std::string_view key)
    {
        return std::find(kKnownIcons.begin(), kKnownIcons.end(), key) != kKnownIcons.end();
    }

    inline std::string Lower(std::string v)
    {
        std::transform(v.begin(), v.end(), v.begin(),
            [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return v;
    }

    // ---- one scene, reduced to the three vocabularies -------------------
    struct Scene
    {
        std::string           id;
        std::string           hay;      // " name id " lowercased, - and _ → space
        std::set<std::string> tags;     // scene-level
        std::set<std::string> posture;  // union of actors[].tags
        std::vector<std::set<std::string>> perActor;
        std::set<std::string> acts;     // actions[].type
    };

    inline bool Has(const std::set<std::string>& s, std::initializer_list<const char*> any)
    {
        for (auto* w : any)
            if (s.count(w))
                return true;
        return false;
    }

    // Penetrative acts. `oral` is gated on the ABSENCE of these so a
    // threesome that also has a blowjob still shows its main position.
    inline bool Penetrative(const Scene& s)
    {
        return Has(s.acts, { "vaginalsex", "analsex", "sex", "mounting", "tribbing",
            "grindingpenis", "leglocking", "vaginalfingering", "analfingering",
            "vaginaltoying", "analtoying", "mdildovaginal", "mdildoanal",
            "vaginalfisting", "analfisting" });
    }
    inline bool Oral(const Scene& s)
    {
        return Has(s.acts, { "blowjob", "deepthroat", "cunnilingus", "lickingvagina",
            "lickingpenis", "facefuck", "rimjob", "anilingus", "facial", "irrumatio",
            "lickingtesticles", "oralfingering", "rubbingpenisagainstface" });
    }
    inline bool Masturbation(const Scene& s)
    {
        return Has(s.acts, { "malemasturbation", "femalemasturbation",
            "masturbation", "rubbingclitoris" });
    }
    // Affection with nothing else going on.  823 scenes carry `hug` and
    // 502 `kissing`, but most of those ALSO have sex in them — hence the
    // caller gates this on the absence of every other act.
    inline bool Affection(const Scene& s)
    {
        return Has(s.acts, { "hug", "hugging", "cuddling", "kissing",
            "kissingneck", "caressing", "holdinghand" });
    }
    // Word-boundary-ish contains: the haystack is space-padded and its
    // separators normalised, so " doggy " matches but "animobject" cannot
    // leak a "bj".
    inline bool Word(const std::string& hay, std::initializer_list<const char*> any)
    {
        for (auto* w : any)
            if (hay.find(std::string(" ") + w + " ") != std::string::npos)
                return true;
        return false;
    }

    // These four additions require a complete, explicit phrase. In particular,
    // generic standing / table / chair tags never imply a furniture-specific icon.
    inline bool Explicit(const Scene& scene, std::initializer_list<const char*> aliases)
    {
        if (Word(scene.hay, aliases))
            return true;
        for (auto tag : scene.tags) {
            for (auto& c : tag)
                if (c == '_' || c == '-') c = ' ';
            for (const auto* alias : aliases)
                if (tag == alias) return true;
        }
        return false;
    }

    inline int CountWith(const std::vector<std::set<std::string>>& per, const char* tag)
    {
        int n = 0;
        for (const auto& p : per)
            if (p.count(tag))
                ++n;
        return n;
    }

    /* THE MATCHER. Stage A = explicit position word (tags or name), Stage B
       = posture/act inference, Stage C = weak fallbacks for the packs that
       ship no posture tags. Order is the algorithm — see the header. */
    inline std::string IconFor(const Scene& s)
    {
        const auto& h = s.hay;

        /* ---- Stage 0: a transition is not a position --------------------
           1,132 of the 8,103 scenes installed here are tagged `transition`
           — they are the moves BETWEEN positions, and drawing whatever
           posture they happen to pass through is worse than saying so. */
        if (s.tags.count("transition") || Word(h, { "transition" }))
            return "transition";

        // ---- Stage A: an explicit position word beats any inference -----
        if (Has(s.tags, { "sixtynine", "69" }) || Word(h, { "69", "sixtynine", "sixty nine", "mutual oral" }))
            return "sixtynine";
        if (Has(s.tags, { "reversecowgirl" }) || Word(h, { "reverse cowgirl", "revcowgirl" }))
            return "cowgirl-lean";
        if (Word(h, { "lotus" }))
            return "lotus";
        if (Has(s.tags, { "cowgirl" }) || Word(h, { "cowgirl", "riding", "straddling", "straddle", "mounted" }))
            return "cowgirl";
        if (Has(s.tags, { "spooning" }) || Word(h, { "spoon", "spooning" }))
            return "spooning";
        if (Has(s.tags, { "prone" }) || Word(h, { "prone" }))
            return "prone";
        if (Word(h, { "carry", "carrying", "carried", "piledriver" }))
            return "carry";
        if (Word(h, { "legs up", "legup", "mating press", "matingpress", "stretch leg", "stretch legs" }))
            return "legsup";
        // Reviewed supplied artwork, selected only by these explicit aliases.
        if (Explicit(s, { "facesitting", "face sitting", "face sit" }))
            return "face-sitting";
        if (Explicit(s, { "bent over table", "bend over table", "bent over a table", "table bent over", "table bendover" }))
            return "bent-over-table";
        if (Explicit(s, { "wall behind", "wall from behind", "against wall from behind", "from behind against wall" }))
            return "wall-behind";
        if (Explicit(s, { "wheelbarrow", "wheel barrow" }))
            return "wheelbarrow";
        if (Has(s.tags, { "oral", "blowjob", "facefuck", "cunnilingus", "facesitting", "deepthroat", "rimjob" }) ||
            Word(h, { "blowjob", "blow job", "oral", "fellatio", "cunnilingus", "facefuck",
                "facesitting", "deepthroat", "deep throat", "rimjob", "irrumatio" }))
            return "oral";
        if (Has(s.tags, { "missionary" }) || Word(h, { "missionary" }))
            return "missionary";
        // doggy BEFORE standing: 524 scenes are standing+bendover.
        if (Has(s.tags, { "doggystyle", "doggy", "behind" }) ||
            Word(h, { "doggy", "doggystyle", "from behind", "rear entry", "bend over",
                "bendover", "bent over", "all fours", "allfours", "rear" }))
            return "doggy";

        /* ---- Stage A2: acts that ARE the position ----------------------
           Each is gated on the absence of penetration so a scene that also
           has sex in it still shows the position the sex is in. */
        if (!Penetrative(s) && (Has(s.acts, { "boobjob" }) || s.tags.count("boobjob")))
            return "titjob";
        if (!Penetrative(s) && (Has(s.acts, { "footjob" }) ||
            Has(s.tags, { "footjob", "footfetish" })))
            return "footjob";
        if (!Penetrative(s) && !Oral(s) &&
            (Has(s.acts, { "handjob", "doublehandjob" }) || s.tags.count("handjob")))
            return "handjob";
        // Solo means ONE actor; a partner watching him is not a solo scene.
        if (s.perActor.size() == 1 && (Masturbation(s) ||
            Has(s.tags, { "solo", "masturbation" })))
            return "solo";
        if (!Penetrative(s) && !Oral(s) && !Masturbation(s) &&
            !Has(s.acts, { "handjob", "boobjob", "footjob", "thighjob", "buttjob" }) &&
            Affection(s))
            return "embrace";
        /* Three or more actors, with no position NAMED in the tags or the
           title: which of them is doing what stops being the useful fact,
           so say "group".  A scene called "Threesome Doggy" already
           returned doggy above and is not reached here. */
        if (s.perActor.size() >= 3)
            return "group";

        // ---- Stage B: posture + act inference ---------------------------
        if (Oral(s) && Has(s.acts, { "cunnilingus", "lickingvagina" }) &&
            Has(s.acts, { "blowjob", "lickingpenis", "deepthroat" }))
            return "sixtynine";
        if (s.posture.count("suspended"))
            return "carry";
        if (CountWith(s.perActor, "lyingside") >= 2)
            return "spooning";
        if (s.posture.count("lyingfront") && !Has(s.posture, { "allfours", "bendover", "bentover" }))
            return "prone";
        if (s.posture.count("ontop") && s.posture.count("facingaway") &&
            Has(s.posture, { "lyingback", "lyingfront" }) && Penetrative(s))
            return "cowgirl-lean";
        if (s.posture.count("sitting") && s.posture.count("ontop") &&
            !s.posture.count("facingaway") && Penetrative(s))
            return "lotus";
        if (s.posture.count("ontop") && s.posture.count("lyingback") && Penetrative(s))
            return "cowgirl";
        if (Has(s.posture, { "allfours", "bendover", "bentover" }))
            return "doggy";
        if (s.posture.count("spreadlegs") && s.posture.count("lyingback") && Penetrative(s))
            return "legsup";
        if (s.posture.count("lyingback") &&
            Has(s.posture, { "kneeling", "lyingfront", "standing", "squatting" }) && Penetrative(s))
            return "missionary";
        if (Oral(s) && !Penetrative(s))
            return "oral";
        if (s.posture.count("standing") && s.perActor.size() > 1) {
            bool all = true;
            for (const auto& p : s.perActor)
                if (!p.empty() && !p.count("standing"))
                    all = false;
            if (all)
                return "standing";
        }
        if (Has(s.posture, { "kneeling", "squatting", "sitting" }))
            return "kneel";
        if (s.posture.count("lyingside"))
            return "spooning";
        if (s.posture.count("lyingback") && Penetrative(s))
            return "missionary";
        if (s.posture.count("standing"))
            return "standing";

        // ---- Stage C: only for packs with no posture tags at all --------
        // "laying" is NOT a position (328 names) — it is allowed here only
        // as a last resort and only when something penetrative is happening.
        if ((s.tags.count("laying") || Word(h, { "laying" })) && Penetrative(s))
            return "missionary";
        if (s.tags.count("standing") || Word(h, { "standing", "upright", "wall" }))
            return "standing";
        // "sit" as a whole word only: the substring hit 571 names, many of
        // them transitions.
        if (Word(h, { "kneel", "kneeling", "sit", "sitting", "squat", "squatting", "chair", "bench", "stool" }))
            return "kneel";
        return "";
    }

    // Optional metadata may be absent, but a supplied field must have its stated
    // type. Reject the complete malformed record rather than inventing a partial
    // scene (e.g. dropping a malformed actor would alter the participant count).
    inline bool Collect(const json& node, const char* key, std::set<std::string>& out)
    {
        const auto it = node.find(key);
        if (it == node.end()) return true;
        if (!it->is_array()) return false;
        for (const auto& value : *it) {
            if (!value.is_string()) return false;
            out.insert(Lower(value.get<std::string>()));
        }
        return true;
    }

    inline bool SceneId(const std::string& id)
    {
        return !id.empty() && std::none_of(id.begin(), id.end(),
            [](unsigned char c) { return c < 32 || c == 127; });
    }

    inline bool ParseScene(const json& node, const std::string& fallbackId, Scene& out)
    {
        if (!node.is_object()) return false;
        for (const char* key : { "id", "name" })
            if (node.contains(key) && !node[key].is_string()) return false;
        Scene parsed;
        parsed.id = node.value("id", std::string{});
        if (parsed.id.empty()) parsed.id = fallbackId;
        if (!SceneId(parsed.id)) return false;
        parsed.hay = " " + Lower(node.value("name", std::string{}) + " " + parsed.id) + " ";
        for (auto& c : parsed.hay)
            if (c == '_' || c == '-') c = ' ';
        if (!Collect(node, "tags", parsed.tags)) return false;
        if (node.contains("actors")) {
            if (!node["actors"].is_array()) return false;
            for (const auto& actor : node["actors"]) {
                if (!actor.is_object()) return false;
                std::set<std::string> mine;
                if (!Collect(actor, "tags", mine)) return false;
                for (auto it = mine.begin(); it != mine.end();)
                    if (it->rfind("animationindex", 0) == 0) it = mine.erase(it);
                    else ++it;
                parsed.posture.insert(mine.begin(), mine.end());
                parsed.perActor.push_back(std::move(mine));
            }
        }
        if (node.contains("actions")) {
            if (!node["actions"].is_array()) return false;
            for (const auto& action : node["actions"]) {
                if (!action.is_object()) return false;
                if (!action.contains("type")) continue;
                if (!action["type"].is_string()) return false;
                parsed.acts.insert(Lower(action["type"].get<std::string>()));
            }
        }
        out = std::move(parsed);
        return true;
    }

    class Index
    {
    public:
        void Invalid() { ++scanned_; ++invalid_; }

        bool Add(const json& node, const std::string& fallbackId)
        {
            Scene scene;
            if (!ParseScene(node, fallbackId, scene)) {
                Invalid();
                return false;
            }
            ++scanned_;
            const auto icon = IconFor(scene);
            const auto [it, inserted] = byId_.emplace(scene.id, icon);
            if (!inserted) {
                ++duplicates_;
                // A known classification conflicting with "unmatched" is also
                // ambiguous. Once conflicted, later copies cannot restore a guess.
                if (it->second != icon) conflicts_.insert(scene.id);
            }
            return true;
        }

        json Result() const
        {
            json icons = json::object();
            for (const auto& [id, icon] : byId_)
                if (!icon.empty() && !conflicts_.count(id)) icons[id] = icon;
            return {
                { "v", kCacheVersion }, { "ok", true }, { "cached", false },
                { "scanned", scanned_ }, { "uniqueScenes", byId_.size() },
                { "matched", icons.size() }, { "invalid", invalid_ },
                { "duplicates", duplicates_ }, { "conflicts", conflicts_.size() },
                { "conflictedIds", conflicts_ }, { "icons", std::move(icons) }
            };
        }

    private:
        std::size_t scanned_ = 0, invalid_ = 0, duplicates_ = 0;
        std::map<std::string, std::string> byId_;
        std::set<std::string> conflicts_;
    };

    inline bool Count(const json& node, const char* key, std::uint64_t& result)
    {
        const auto it = node.find(key);
        if (it == node.end() || !it->is_number_integer()) return false;
        if (it->is_number_unsigned()) {
            result = it->get<std::uint64_t>();
            return result <= 0x7FFFFFFFFFFFFFFFULL;
        }
        const auto count = it->get<std::int64_t>();
        if (count < 0) return false;
        result = static_cast<std::uint64_t>(count);
        return true;
    }

    inline bool ValidCache(const json& cache)
    {
        if (!cache.is_object() || !cache.contains("v") ||
            !cache["v"].is_number_integer() || cache["v"] != kCacheVersion ||
            !cache.contains("ok") || !cache["ok"].is_boolean() || !cache["ok"].get<bool>() ||
            !cache.contains("cached") || !cache["cached"].is_boolean() ||
            !cache.contains("icons") || !cache["icons"].is_object() ||
            !cache.contains("conflictedIds") || !cache["conflictedIds"].is_array()) return false;
        for (const auto& [id, value] : cache["icons"].items())
            if (!SceneId(id) || !value.is_string() || !KnownIcon(value.get_ref<const std::string&>())) return false;
        std::set<std::string> conflicts;
        for (const auto& id : cache["conflictedIds"]) {
            if (!id.is_string()) return false;
            const auto& text = id.get_ref<const std::string&>();
            if (!SceneId(text) || !conflicts.insert(text).second || cache["icons"].contains(text)) return false;
        }
        std::uint64_t scanned, unique, matched, invalid, duplicates, conflictCount;
        if (!Count(cache, "scanned", scanned) || !Count(cache, "uniqueScenes", unique) ||
            !Count(cache, "matched", matched) || !Count(cache, "invalid", invalid) ||
            !Count(cache, "duplicates", duplicates) || !Count(cache, "conflicts", conflictCount)) return false;
        // Subtractions after bounds checks also reject overflowing counter sums.
        return invalid <= scanned && duplicates <= scanned - invalid &&
            unique == scanned - invalid - duplicates && conflictCount <= unique &&
            conflictCount <= duplicates && conflictCount == conflicts.size() &&
            matched <= unique - conflictCount && matched == cache["icons"].size();
    }
} // namespace SceneTagsModel
