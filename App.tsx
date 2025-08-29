/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import React, { useState, useCallback, useRef, useEffect } from 'react';
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop';
import JSZip from 'jszip';
import { generateEditedImage, generateFilteredImage, generateAdjustedImage } from './services/geminiService';
import Header from './components/Header';
import Spinner from './components/Spinner';
import FilterPanel from './components/FilterPanel';
import AdjustmentPanel from './components/AdjustmentPanel';
import CropPanel from './components/CropPanel';
import { UndoIcon, RedoIcon, EyeIcon, MagicWandIcon } from './components/icons';
import StartScreen from './components/StartScreen';

// Helper to convert a data URL string to a File object
const dataURLtoFile = (dataurl: string, filename: string): File => {
    const arr = dataurl.split(',');
    if (arr.length < 2) throw new Error("Invalid data URL");
    const mimeMatch = arr[0].match(/:(.*?);/);
    if (!mimeMatch || !mimeMatch[1]) throw new Error("Could not parse MIME type from data URL");

    const mime = mimeMatch[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while(n--){
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, {type:mime});
}

type Tab = 'retouch' | 'adjust' | 'filters' | 'crop';
type EditMode = 'single' | 'batch';

type BatchImage = {
    id: number;
    name: string;
    original: File;
    processed: File | null;
    originalUrl: string;
    processedUrl: string | null;
    status: 'pending' | 'processing' | 'done' | 'error';
    error?: string;
};


const App: React.FC = () => {
  // Common state
  const [mode, setMode] = useState<EditMode>('single');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingMessage, setLoadingMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('retouch');
  
  // Single image mode state
  const [history, setHistory] = useState<File[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [prompt, setPrompt] = useState<string>('');
  const [editHotspot, setEditHotspot] = useState<{ x: number, y: number } | null>(null);
  const [displayHotspot, setDisplayHotspot] = useState<{ x: number, y: number } | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [aspect, setAspect] = useState<number | undefined>();
  const [isComparing, setIsComparing] = useState<boolean>(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // Batch image mode state
  const [batchImages, setBatchImages] = useState<BatchImage[]>([]);
  const [selectedBatchImageId, setSelectedBatchImageId] = useState<number | null>(null);
  const [previousBatchState, setPreviousBatchState] = useState<BatchImage[] | null>(null);
  const [editingFromBatchId, setEditingFromBatchId] = useState<number | null>(null);


  const currentImage = history[historyIndex] ?? null;
  const originalImage = history[0] ?? null;
  const hasImages = history.length > 0 || batchImages.length > 0;

  const [currentImageUrl, setCurrentImageUrl] = useState<string | null>(null);
  const [originalImageUrl, setOriginalImageUrl] = useState<string | null>(null);

  // Effect to create and revoke object URLs safely for the current image in single mode
  useEffect(() => {
    if (currentImage) {
      const url = URL.createObjectURL(currentImage);
      setCurrentImageUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setCurrentImageUrl(null);
    }
  }, [currentImage]);
  
  // Effect to create and revoke object URLs safely for the original image in single mode
  useEffect(() => {
    if (originalImage) {
      const url = URL.createObjectURL(originalImage);
      setOriginalImageUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setOriginalImageUrl(null);
    }
  }, [originalImage]);

  // Effect to clean up batch image URLs on unmount
  useEffect(() => {
    return () => {
        batchImages.forEach(image => {
            URL.revokeObjectURL(image.originalUrl);
            if (image.processedUrl) {
                URL.revokeObjectURL(image.processedUrl);
            }
        });
    };
  }, [batchImages]);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const addImageToHistory = useCallback((newImageFile: File) => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newImageFile);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    // Reset transient states after an action
    setCrop(undefined);
    setCompletedCrop(undefined);
  }, [history, historyIndex]);

  const handleFileSelect = (files: FileList | null) => {
    if (!files || files.length === 0) return;

    setError(null);
    setPrompt('');

    if (files.length > 1) {
        // Batch Mode
        setMode('batch');
        const newImages: BatchImage[] = Array.from(files).map((file, index) => ({
            id: index,
            name: file.name,
            original: file,
            processed: null,
            originalUrl: URL.createObjectURL(file),
            processedUrl: null,
            status: 'pending',
        }));
        setBatchImages(newImages);
        setSelectedBatchImageId(0);
        setHistory([]); // Clear single mode history
        setHistoryIndex(-1);
        setActiveTab('filters'); // Default to a batch-compatible tab
    } else {
        // Single Mode
        setMode('single');
        setBatchImages([]); // Clear batch mode images
        setError(null);
        setHistory([files[0]]);
        setHistoryIndex(0);
        setEditHotspot(null);
        setDisplayHotspot(null);
        setActiveTab('retouch');
        setCrop(undefined);
        setCompletedCrop(undefined);
    }
  };


  const handleGenerate = useCallback(async () => {
    if (!currentImage) {
      setError('No image loaded to edit.');
      return;
    }
    
    if (!prompt.trim()) {
        setError('Please enter a description for your edit.');
        return;
    }

    if (!editHotspot) {
        setError('Please click on the image to select an area to edit.');
        return;
    }

    setIsLoading(true);
    setLoadingMessage('');
    setError(null);
    
    try {
        const editedImageUrl = await generateEditedImage(currentImage, prompt, editHotspot);
        const newImageFile = dataURLtoFile(editedImageUrl, `edited-${Date.now()}.png`);
        addImageToHistory(newImageFile);
        setEditHotspot(null);
        setDisplayHotspot(null);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to generate the image. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImage, prompt, editHotspot, addImageToHistory]);
  
  const handleApplyFilter = useCallback(async (filterPrompt: string) => {
    if (!currentImage) {
      setError('No image loaded to apply a filter to.');
      return;
    }
    
    setIsLoading(true);
    setLoadingMessage('');
    setError(null);
    
    try {
        const filteredImageUrl = await generateFilteredImage(currentImage, filterPrompt);
        const newImageFile = dataURLtoFile(filteredImageUrl, `filtered-${Date.now()}.png`);
        addImageToHistory(newImageFile);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to apply the filter. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImage, addImageToHistory]);
  
  const handleApplyAdjustment = useCallback(async (adjustmentPrompt: string) => {
    if (!currentImage) {
      setError('No image loaded to apply an adjustment to.');
      return;
    }
    
    setIsLoading(true);
    setLoadingMessage('');
    setError(null);
    
    try {
        const adjustedImageUrl = await generateAdjustedImage(currentImage, adjustmentPrompt);
        const newImageFile = dataURLtoFile(adjustedImageUrl, `adjusted-${Date.now()}.png`);
        addImageToHistory(newImageFile);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
        setError(`Failed to apply the adjustment. ${errorMessage}`);
        console.error(err);
    } finally {
        setIsLoading(false);
    }
  }, [currentImage, addImageToHistory]);
  
  const handleApplyToAll = useCallback(async (prompt: string, generator: (image: File, prompt: string) => Promise<string>) => {
    if (batchImages.length === 0) {
        setError('No images loaded for batch processing.');
        return;
    }

    setIsLoading(true);
    setError(null);

    // Set all to processing
    setBatchImages(imgs => imgs.map(img => ({ ...img, status: 'processing' })));

    for (let i = 0; i < batchImages.length; i++) {
        const image = batchImages[i];
        try {
            setLoadingMessage(`Processing ${image.name} (${i + 1}/${batchImages.length})...`);
            const resultUrl = await generator(image.original, prompt);
            const newFile = dataURLtoFile(resultUrl, `processed-${image.name}`);
            
            setBatchImages(currentImages => currentImages.map(img => {
                if (img.id === image.id) {
                    // Revoke old URL if it exists
                    if (img.processedUrl) URL.revokeObjectURL(img.processedUrl);
                    return {
                        ...img,
                        processed: newFile,
                        processedUrl: URL.createObjectURL(newFile),
                        status: 'done',
                        error: undefined,
                    };
                }
                return img;
            }));
        } catch (err) {
             const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
             console.error(`Failed to process ${image.name}:`, err);
             setBatchImages(currentImages => currentImages.map(img => 
                img.id === image.id ? { ...img, status: 'error', error: errorMessage } : img
            ));
        }
    }
    setIsLoading(false);
    setLoadingMessage('');
  }, [batchImages]);

  const handleApplyFilterToAll = (filterPrompt: string) => handleApplyToAll(filterPrompt, generateFilteredImage);
  const handleApplyAdjustmentToAll = (adjustmentPrompt: string) => handleApplyToAll(adjustmentPrompt, generateAdjustedImage);

  const handleApplyCrop = useCallback(() => {
    if (!completedCrop || !imgRef.current) {
        setError('Please select an area to crop.');
        return;
    }

    const image = imgRef.current;
    const canvas = document.createElement('canvas');
    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;
    
    canvas.width = completedCrop.width;
    canvas.height = completedCrop.height;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
        setError('Could not process the crop.');
        return;
    }

    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = completedCrop.width * pixelRatio;
    canvas.height = completedCrop.height * pixelRatio;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.imageSmoothingQuality = 'high';

    ctx.drawImage(
      image,
      completedCrop.x * scaleX,
      completedCrop.y * scaleY,
      completedCrop.width * scaleX,
      completedCrop.height * scaleY,
      0,
      0,
      completedCrop.width,
      completedCrop.height,
    );
    
    const croppedImageUrl = canvas.toDataURL('image/png');
    const newImageFile = dataURLtoFile(croppedImageUrl, `cropped-${Date.now()}.png`);
    addImageToHistory(newImageFile);

  }, [completedCrop, addImageToHistory]);

  const handleUndo = useCallback(() => {
    if (canUndo) {
      setHistoryIndex(historyIndex - 1);
      setEditHotspot(null);
      setDisplayHotspot(null);
    }
  }, [canUndo, historyIndex]);
  
  const handleRedo = useCallback(() => {
    if (canRedo) {
      setHistoryIndex(historyIndex + 1);
      setEditHotspot(null);
      setDisplayHotspot(null);
    }
  }, [canRedo, historyIndex]);

  const handleReset = useCallback(() => {
    if (history.length > 0) {
      setHistoryIndex(0);
      setError(null);
      setEditHotspot(null);
      setDisplayHotspot(null);
    }
  }, [history]);

  const handleUploadNew = useCallback(() => {
      // Clean up Object URLs from batch mode
      batchImages.forEach(image => {
            URL.revokeObjectURL(image.originalUrl);
            if (image.processedUrl) {
                URL.revokeObjectURL(image.processedUrl);
            }
      });
      setMode('single');
      setHistory([]);
      setHistoryIndex(-1);
      setBatchImages([]);
      setSelectedBatchImageId(null);
      setError(null);
      setPrompt('');
      setEditHotspot(null);
      setDisplayHotspot(null);
      setPreviousBatchState(null);
      setEditingFromBatchId(null);
  }, [batchImages]);

  const handleBackToBatch = useCallback(() => {
    if (!previousBatchState || editingFromBatchId === null || !currentImage) return;

    // The currentImage is the latest edited file from single mode
    const updatedBatch = previousBatchState.map(img => {
        if (img.id === editingFromBatchId) {
            // Revoke the old URL before replacing
            if (img.processedUrl) {
                URL.revokeObjectURL(img.processedUrl);
            }
            // Create a new URL for the updated image file
            const newProcessedUrl = URL.createObjectURL(currentImage);
            return { ...img, processed: currentImage, processedUrl: newProcessedUrl };
        }
        return img;
    });

    setBatchImages(updatedBatch);
    setSelectedBatchImageId(editingFromBatchId); // Reselect the edited image
    setMode('batch');

    // Cleanup single mode state
    setHistory([]);
    setHistoryIndex(-1);
    
    // Cleanup batch-return state
    setPreviousBatchState(null);
    setEditingFromBatchId(null);

  }, [previousBatchState, editingFromBatchId, currentImage]);

  const handleDownload = useCallback(() => {
      if (currentImage) {
          const link = document.createElement('a');
          link.href = URL.createObjectURL(currentImage);
          link.download = `edited-${currentImage.name}`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(link.href);
      }
  }, [currentImage]);

  const handleDownloadAll = useCallback(async () => {
    const processedImages = batchImages.filter(img => img.status === 'done' && img.processed);
    if (processedImages.length === 0) {
        setError("No images have been processed successfully to download.");
        return;
    }

    setIsLoading(true);
    setLoadingMessage('Zipping files...');

    try {
        const zip = new JSZip();
        for (const image of processedImages) {
            zip.file(image.processed!.name, image.processed!);
        }
        const content = await zip.generateAsync({ type: "blob" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(content);
        link.download = "pixshop_batch_edit.zip";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    } catch (err) {
        setError("Failed to create zip file.");
        console.error(err);
    }

    setIsLoading(false);
    setLoadingMessage('');
  }, [batchImages]);
  
  const handleImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (activeTab !== 'retouch') return;
    
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();

    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    
    setDisplayHotspot({ x: offsetX, y: offsetY });

    const { naturalWidth, naturalHeight, clientWidth, clientHeight } = img;
    const scaleX = naturalWidth / clientWidth;
    const scaleY = naturalHeight / clientHeight;

    const originalX = Math.round(offsetX * scaleX);
    const originalY = Math.round(offsetY * scaleY);

    setEditHotspot({ x: originalX, y: originalY });
  };

  const handleEditSingleFromBatch = (imageId: number) => {
    const imageToEdit = batchImages.find(img => img.id === imageId);

    if (imageToEdit && imageToEdit.processed) {
        // Save batch state before switching
        setPreviousBatchState(batchImages);
        setEditingFromBatchId(imageId);

        // Switch to single mode with the processed image
        setMode('single');
        setHistory([imageToEdit.processed]);
        setHistoryIndex(0);
        
        // Clean up batch state for the UI
        setBatchImages([]);
        setSelectedBatchImageId(null);

        // Reset single mode UI state
        setError(null);
        setPrompt('');
        setEditHotspot(null);
        setDisplayHotspot(null);
        setActiveTab('retouch'); // Default to the most detailed editing tab
        setCrop(undefined);
        setCompletedCrop(undefined);
    } else {
        setError("Could not load the selected image for individual editing.");
    }
  };
  
  const renderSingleModeUI = () => {
    const imageDisplay = (
      <div className="relative">
        {/* Base image is the original, always at the bottom */}
        {originalImageUrl && (
            <img
                key={originalImageUrl}
                src={originalImageUrl}
                alt="Original"
                className="w-full h-auto object-contain max-h-[60vh] rounded-xl pointer-events-none"
            />
        )}
        {/* The current image is an overlay that fades in/out for comparison */}
        {currentImageUrl &&
          <img
              ref={imgRef}
              key={currentImageUrl}
              src={currentImageUrl}
              alt="Current"
              onClick={handleImageClick}
              className={`absolute top-0 left-0 w-full h-auto object-contain max-h-[60vh] rounded-xl transition-opacity duration-200 ease-in-out ${isComparing ? 'opacity-0' : 'opacity-100'} ${activeTab === 'retouch' ? 'cursor-crosshair' : ''}`}
          />
        }
      </div>
    );
    
    const cropImageElement = (
      <img 
        ref={imgRef}
        key={`crop-${currentImageUrl}`}
        src={currentImageUrl!} 
        alt="Crop this image"
        className="w-full h-auto object-contain max-h-[60vh] rounded-xl"
      />
    );


    return (
      <div className="w-full max-w-4xl mx-auto flex flex-col items-center gap-6 animate-fade-in">
        <div className="relative w-full shadow-2xl rounded-xl overflow-hidden bg-black/20">
            {isLoading && (
                <div className="absolute inset-0 bg-black/70 z-30 flex flex-col items-center justify-center gap-4 animate-fade-in">
                    <Spinner />
                    <p className="text-gray-300">{loadingMessage || 'AI is working its magic...'}</p>
                </div>
            )}
            
            {activeTab === 'crop' ? (
              <ReactCrop 
                crop={crop} 
                onChange={c => setCrop(c)} 
                onComplete={c => setCompletedCrop(c)}
                aspect={aspect}
                className="max-h-[60vh]"
              >
                {cropImageElement}
              </ReactCrop>
            ) : imageDisplay }

            {displayHotspot && !isLoading && activeTab === 'retouch' && (
                <div 
                    className="absolute rounded-full w-6 h-6 bg-blue-500/50 border-2 border-white pointer-events-none -translate-x-1/2 -translate-y-1/2 z-10"
                    style={{ left: `${displayHotspot.x}px`, top: `${displayHotspot.y}px` }}
                >
                    <div className="absolute inset-0 rounded-full w-6 h-6 animate-ping bg-blue-400"></div>
                </div>
            )}
        </div>
        
        <div className="w-full bg-gray-800/80 border border-gray-700/80 rounded-lg p-2 flex items-center justify-center gap-2 backdrop-blur-sm">
            {(['retouch', 'crop', 'adjust', 'filters'] as Tab[]).map(tab => (
                 <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`w-full capitalize font-semibold py-3 px-5 rounded-md transition-all duration-200 text-base ${
                        activeTab === tab 
                        ? 'bg-gradient-to-br from-blue-500 to-cyan-400 text-white shadow-lg shadow-cyan-500/40' 
                        : 'text-gray-300 hover:text-white hover:bg-white/10'
                    }`}
                >
                    {tab}
                </button>
            ))}
        </div>
        
        <div className="w-full">
            {activeTab === 'retouch' && (
                <div className="flex flex-col items-center gap-4">
                    <p className="text-md text-gray-400">
                        {editHotspot ? 'Great! Now describe your localized edit below.' : 'Click an area on the image to make a precise edit.'}
                    </p>
                    <form onSubmit={(e) => { e.preventDefault(); handleGenerate(); }} className="w-full flex items-center gap-2">
                        <input
                            type="text"
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            placeholder={editHotspot ? "e.g., 'change my shirt color to blue'" : "First click a point on the image"}
                            className="flex-grow bg-gray-800 border border-gray-700 text-gray-200 rounded-lg p-5 text-lg focus:ring-2 focus:ring-blue-500 focus:outline-none transition w-full disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={isLoading || !editHotspot}
                        />
                        <button 
                            type="submit"
                            className="bg-gradient-to-br from-blue-600 to-blue-500 text-white font-bold py-5 px-8 text-lg rounded-lg transition-all duration-300 ease-in-out shadow-lg shadow-blue-500/20 hover:shadow-xl hover:shadow-blue-500/40 hover:-translate-y-px active:scale-95 active:shadow-inner disabled:from-blue-800 disabled:to-blue-700 disabled:shadow-none disabled:cursor-not-allowed disabled:transform-none"
                            disabled={isLoading || !prompt.trim() || !editHotspot}
                        >
                            Generate
                        </button>
                    </form>
                </div>
            )}
            {activeTab === 'crop' && <CropPanel onApplyCrop={handleApplyCrop} onSetAspect={setAspect} isLoading={isLoading} isCropping={!!completedCrop?.width && completedCrop.width > 0} />}
            {activeTab === 'adjust' && <AdjustmentPanel onApplyAdjustment={handleApplyAdjustment} isLoading={isLoading} />}
            {activeTab === 'filters' && <FilterPanel onApplyFilter={handleApplyFilter} isLoading={isLoading} />}
        </div>
        
        <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
            <button 
                onClick={handleUndo}
                disabled={!canUndo}
                className="flex items-center justify-center text-center bg-white/10 border border-white/20 text-gray-200 font-semibold py-3 px-5 rounded-md transition-all duration-200 ease-in-out hover:bg-white/20 hover:border-white/30 active:scale-95 text-base disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-white/5"
                aria-label="Undo last action"
            >
                <UndoIcon className="w-5 h-5 mr-2" />
                Undo
            </button>
            <button 
                onClick={handleRedo}
                disabled={!canRedo}
                className="flex items-center justify-center text-center bg-white/10 border border-white/20 text-gray-200 font-semibold py-3 px-5 rounded-md transition-all duration-200 ease-in-out hover:bg-white/20 hover:border-white/30 active:scale-95 text-base disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-white/5"
                aria-label="Redo last action"
            >
                <RedoIcon className="w-5 h-5 mr-2" />
                Redo
            </button>
            
            <div className="h-6 w-px bg-gray-600 mx-1 hidden sm:block"></div>

            {canUndo && (
              <button 
                  onMouseDown={() => setIsComparing(true)}
                  onMouseUp={() => setIsComparing(false)}
                  onMouseLeave={() => setIsComparing(false)}
                  onTouchStart={() => setIsComparing(true)}
                  onTouchEnd={() => setIsComparing(false)}
                  className="flex items-center justify-center text-center bg-white/10 border border-white/20 text-gray-200 font-semibold py-3 px-5 rounded-md transition-all duration-200 ease-in-out hover:bg-white/20 hover:border-white/30 active:scale-95 text-base"
                  aria-label="Press and hold to see original image"
              >
                  <EyeIcon className="w-5 h-5 mr-2" />
                  Compare
              </button>
            )}

            <button 
                onClick={handleReset}
                disabled={!canUndo}
                className="text-center bg-transparent border border-white/20 text-gray-200 font-semibold py-3 px-5 rounded-md transition-all duration-200 ease-in-out hover:bg-white/10 hover:border-white/30 active:scale-95 text-base disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-transparent"
              >
                Reset
            </button>
            <button 
                onClick={handleUploadNew}
                className="text-center bg-white/10 border border-white/20 text-gray-200 font-semibold py-3 px-5 rounded-md transition-all duration-200 ease-in-out hover:bg-white/20 hover:border-white/30 active:scale-95 text-base"
            >
                Start Over
            </button>

            <button 
                onClick={handleDownload}
                className="flex-grow sm:flex-grow-0 ml-auto bg-gradient-to-br from-green-600 to-green-500 text-white font-bold py-3 px-5 rounded-md transition-all duration-300 ease-in-out shadow-lg shadow-green-500/20 hover:shadow-xl hover:shadow-green-500/40 hover:-translate-y-px active:scale-95 active:shadow-inner text-base"
            >
                Download Image
            </button>
        </div>
      </div>
    );
  };

  const renderBatchModeUI = () => {
    const selectedImage = batchImages.find(img => img.id === selectedBatchImageId);
    const allDone = batchImages.length > 0 && batchImages.every(img => img.status === 'done' || img.status === 'error');
    const successfulImagesCount = batchImages.filter(img => img.status === 'done').length;

    return (
        <div className="w-full max-w-7xl mx-auto flex flex-col items-center gap-6 animate-fade-in">
            <div className="relative w-full shadow-2xl rounded-xl overflow-hidden bg-black/20 flex items-center justify-center" style={{ minHeight: '50vh' }}>
                 {isLoading && (
                    <div className="absolute inset-0 bg-black/70 z-30 flex flex-col items-center justify-center gap-4 animate-fade-in">
                        <Spinner />
                        <p className="text-gray-300">{loadingMessage || 'AI is working its magic...'}</p>
                    </div>
                )}
                {selectedImage ? (
                    <img 
                        src={selectedImage.processedUrl || selectedImage.originalUrl} 
                        alt={`Preview of ${selectedImage.name}`}
                        className="w-full h-auto object-contain max-h-[60vh] rounded-xl"
                    />
                ) : <p className="text-gray-400">No image selected</p>}
            </div>

            <div className="w-full bg-gray-900/50 p-2 rounded-lg backdrop-blur-sm">
                <div className="flex gap-3 overflow-x-auto p-2">
                    {batchImages.map(img => (
                        <div 
                          key={img.id} 
                          onClick={() => setSelectedBatchImageId(img.id)} 
                          title={img.name}
                          className={`group relative flex-shrink-0 w-28 h-28 rounded-md overflow-hidden cursor-pointer border-2 transition-all ${selectedBatchImageId === img.id ? 'border-blue-500 scale-105' : 'border-transparent hover:border-gray-500'}`}
                        >
                            <img src={img.processedUrl || img.originalUrl} alt={img.name} className="w-full h-full object-cover" />
                            <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-1">
                                <p className="text-white text-xs truncate">{img.name}</p>
                            </div>
                            {img.status === 'processing' && <div className="absolute inset-0 bg-black/70 flex items-center justify-center"><Spinner /></div>}
                            {img.status === 'done' && <div className="absolute top-1 right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-gray-900" title="Processed successfully"></div>}
                            {img.status === 'error' && <div className="absolute top-1 right-1 w-4 h-4 bg-red-500 rounded-full border-2 border-gray-900" title={`Error: ${img.error}`}></div>}
                            
                            {img.status === 'done' && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleEditSingleFromBatch(img.id);
                                    }}
                                    className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center z-10"
                                    title="Edit this image individually"
                                    aria-label={`Edit ${img.name} individually`}
                                >
                                    <MagicWandIcon className="w-8 h-8 text-white" />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            <div className="w-full bg-gray-800/80 border border-gray-700/80 rounded-lg p-2 flex items-center justify-center gap-2 backdrop-blur-sm">
                {(['retouch', 'crop', 'adjust', 'filters'] as Tab[]).map(tab => {
                    const isDisabled = tab === 'retouch' || tab === 'crop';
                    return (
                         <button
                            key={tab}
                            onClick={() => !isDisabled && setActiveTab(tab)}
                            disabled={isDisabled}
                            title={isDisabled ? "This feature is not available in batch mode" : ""}
                            className={`w-full capitalize font-semibold py-3 px-5 rounded-md transition-all duration-200 text-base ${
                                activeTab === tab 
                                ? 'bg-gradient-to-br from-blue-500 to-cyan-400 text-white shadow-lg shadow-cyan-500/40' 
                                : 'text-gray-300 hover:text-white hover:bg-white/10'
                            } ${isDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            {tab}
                        </button>
                    )
                })}
            </div>

            <div className="w-full">
                {activeTab === 'adjust' && <AdjustmentPanel onApplyAdjustment={handleApplyAdjustmentToAll} isLoading={isLoading} isBatchMode={true} />}
                {activeTab === 'filters' && <FilterPanel onApplyFilter={handleApplyFilterToAll} isLoading={isLoading} isBatchMode={true} />}
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
                <button 
                    onClick={handleUploadNew}
                    className="text-center bg-white/10 border border-white/20 text-gray-200 font-semibold py-3 px-5 rounded-md transition-all duration-200 ease-in-out hover:bg-white/20 hover:border-white/30 active:scale-95 text-base"
                >
                    Start Over
                </button>
                <button 
                    onClick={handleDownloadAll}
                    disabled={isLoading || !allDone || successfulImagesCount === 0}
                    className="flex-grow sm:flex-grow-0 ml-auto bg-gradient-to-br from-green-600 to-green-500 text-white font-bold py-3 px-5 rounded-md transition-all duration-300 ease-in-out shadow-lg shadow-green-500/20 hover:shadow-xl hover:shadow-green-500/40 hover:-translate-y-px active:scale-95 active:shadow-inner text-base disabled:from-green-800 disabled:to-green-700 disabled:shadow-none disabled:cursor-not-allowed disabled:transform-none"
                >
                    Download All ({successfulImagesCount})
                </button>
            </div>
        </div>
    );
  }

  const renderContent = () => {
    if (error) {
       return (
           <div className="text-center animate-fade-in bg-red-500/10 border border-red-500/20 p-8 rounded-lg max-w-2xl mx-auto flex flex-col items-center gap-4">
            <h2 className="text-2xl font-bold text-red-300">An Error Occurred</h2>
            <p className="text-md text-red-400">{error}</p>
            <button
                onClick={() => setError(null)}
                className="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-6 rounded-lg text-md transition-colors"
              >
                Try Again
            </button>
          </div>
        );
    }
    
    if (!hasImages) {
      return <StartScreen onFileSelect={handleFileSelect} />;
    }

    if (mode === 'batch') {
      return renderBatchModeUI();
    }
    
    return renderSingleModeUI();
  };
  
  const isReturningToBatch = previousBatchState !== null;

  return (
    <div className="min-h-screen text-gray-100 flex flex-col">
      <Header 
        onBack={isReturningToBatch ? handleBackToBatch : handleUploadNew} 
        showBackButton={hasImages}
        isReturningToBatch={isReturningToBatch}
      />
      <main className={`flex-grow w-full max-w-[1600px] mx-auto p-4 md:p-8 flex justify-center ${hasImages ? 'items-start' : 'items-center'}`}>
        {renderContent()}
      </main>
    </div>
  );
};

export default App;