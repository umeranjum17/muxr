// A whisper.cpp reader that fills whisper_full_params the way whisper.rn's
// transcribeData does (cpp/jsi/RNWhisperJSI.cpp createTranscribeConfig and
// decodePcm16), built from the sources whisper.rn itself vendors. The model
// loads once; each request is one reading.
//
// Request: one line of space-separated key=value settings ending in
// `bytes=N`, then N bytes of 16 kHz mono PCM16. `prompt` is URL-encoded.
// Reply: one JSON line {"ms":…,"segments":[{"t0":…,"t1":…,"text":…}]}.
#include "whisper.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

static std::string urlDecode(const std::string &value) {
    std::string out;
    for (size_t i = 0; i < value.size(); ++i) {
        if (value[i] == '%' && i + 2 < value.size()) {
            out += static_cast<char>(std::stoi(value.substr(i + 1, 2), nullptr, 16));
            i += 2;
        } else {
            out += value[i];
        }
    }
    return out;
}

static std::string jsonString(const std::string &value) {
    std::string out = "\"";
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
        else if (c < 0x20) { char buf[8]; snprintf(buf, sizeof buf, "\\u%04x", c); out += buf; }
        else out += static_cast<char>(c);
    }
    return out + "\"";
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: whisperBench <model.bin>\n");
        return 2;
    }
    whisper_log_set([](enum wsp_ggml_log_level, const char *, void *) {}, nullptr);
    whisper_context_params contextParams = whisper_context_default_params();
    contextParams.use_gpu = false;
    whisper_context *context = whisper_init_from_file_with_params(argv[1], contextParams);
    if (context == nullptr) {
        fprintf(stderr, "could not load %s\n", argv[1]);
        return 1;
    }
    std::cout << "{\"ready\":true}" << std::endl;

    std::string line;
    while (std::getline(std::cin, line)) {
        std::map<std::string, std::string> options;
        std::istringstream words(line);
        std::string word;
        while (words >> word) {
            size_t eq = word.find('=');
            if (eq != std::string::npos) options[word.substr(0, eq)] = word.substr(eq + 1);
        }
        auto integer = [&](const char *key, int fallback) {
            return options.count(key) ? std::stoi(options[key]) : fallback;
        };
        auto real = [&](const char *key, float fallback) {
            return options.count(key) ? std::stof(options[key]) : fallback;
        };

        std::vector<uint8_t> bytes(integer("bytes", 0));
        std::cin.read(reinterpret_cast<char *>(bytes.data()), bytes.size());
        std::vector<float> audio(bytes.size() / 2);
        for (size_t i = 0; i < audio.size(); ++i) {
            int16_t sample = 0;
            std::memcpy(&sample, bytes.data() + i * 2, 2);
            audio[i] = std::max(-1.0f, std::min(1.0f, static_cast<float>(sample) / 32767.0f));
        }

        whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        params.print_realtime = false;
        params.print_progress = false;
        params.print_timestamps = false;
        params.print_special = false;
        params.n_threads = integer("maxThreads", 4);
        params.token_timestamps = integer("tokenTimestamps", 0) != 0;
        params.max_len = integer("maxLen", params.max_len);
        params.n_max_text_ctx = integer("maxContext", params.n_max_text_ctx);
        params.thold_pt = real("wordThold", params.thold_pt);
        params.temperature = real("temperature", params.temperature);
        params.temperature_inc = real("temperatureInc", params.temperature_inc);
        params.greedy.best_of = integer("bestOf", params.greedy.best_of);
        params.audio_ctx = integer("audioCtx", params.audio_ctx);
        int beamSize = integer("beamSize", -1);
        if (beamSize > 0) {
            params.strategy = WHISPER_SAMPLING_BEAM_SEARCH;
            params.beam_search.beam_size = beamSize;
        }
        std::string prompt = urlDecode(options["prompt"]);
        if (!prompt.empty()) params.initial_prompt = prompt.c_str();
        std::string language = options["language"];
        if (!language.empty()) params.language = language.c_str();
        params.no_context = true;
        params.single_segment = false;

        auto started = std::chrono::steady_clock::now();
        int code = whisper_full_parallel(context, params, audio.data(), static_cast<int>(audio.size()), 1);
        double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();

        std::ostringstream reply;
        reply << "{\"code\":" << code << ",\"ms\":" << ms << ",\"segments\":[";
        int count = whisper_full_n_segments(context);
        for (int i = 0; i < count; ++i) {
            if (i) reply << ",";
            reply << "{\"t0\":" << whisper_full_get_segment_t0(context, i)
                  << ",\"t1\":" << whisper_full_get_segment_t1(context, i)
                  << ",\"text\":" << jsonString(whisper_full_get_segment_text(context, i)) << "}";
        }
        reply << "]}";
        std::cout << reply.str() << std::endl;
    }
    whisper_free(context);
    return 0;
}
